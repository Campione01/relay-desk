using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// A GUI-subsystem executable: host and short-lived pipe clients never allocate a console.
internal static class RelayNativeHost {
    const int MaxFrame = 32 * 1024 * 1024;
    const long MaxQueued = 64L * 1024 * 1024;
    // Below the client's 5 s acknowledgement deadline, so a busy host rejects explicitly and the Mod retries.
    const int SenderWait = 4000;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly object OutputLock = new object();
    static readonly object SenderLock = new object();
    static readonly object QueueLock = new object();
    static readonly Queue<string> Requests = new Queue<string>();
    static readonly List<NamedPipeServerStream> Pipes = new List<NamedPipeServerStream>();
    static readonly object PipesLock = new object();
    static long QueuedBytes;
    static int Receiver;
    static volatile bool Closing;
    static string PipeName, Nonce;
    static StreamWriter Output;
    static IntPtr Job, ConsoleHandle, Child, InputWrite, OutputRead;
    static uint ChildPid;
    static Thread OutputThread;
    static readonly ManualResetEvent ChildExited = new ManualResetEvent(false);
    static readonly object LifecycleLock = new object();
    static bool Started;
    static bool StartupInputClosed;
    static int ExitPublished;

    static JavaScriptSerializer Serializer() { return new JavaScriptSerializer { MaxJsonLength = MaxFrame, RecursionLimit = 128 }; }
    static Dictionary<string, object> Obj(string json) { return Serializer().Deserialize<Dictionary<string, object>>(json); }
    static string Json(object value) { return Serializer().Serialize(value); }
    static string Text(Dictionary<string, object> d, string key, string fallback = null) { object v; return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v) : fallback; }
    static int Number(Dictionary<string, object> d, string key, int fallback) { object v; return d.TryGetValue(key, out v) ? Convert.ToInt32(v) : fallback; }
    static void Emit(object value) {
        string line = Json(value);
        if (Utf8.GetByteCount(line) > MaxFrame) throw new InvalidDataException("frame_too_large");
        lock (OutputLock) { Output.WriteLine(line); Output.Flush(); }
    }
    static string ReadLine(Stream stream) {
        using (var line = new MemoryStream()) {
            int b;
            while ((b = stream.ReadByte()) >= 0) {
                if (b == 10) return Utf8.GetString(line.ToArray()).TrimEnd('\r');
                if (line.Length >= MaxFrame) throw new InvalidDataException("frame_too_large");
                line.WriteByte((byte)b);
            }
            if (line.Length != 0) throw new EndOfStreamException("incomplete_frame");
            return null;
        }
    }
    static string ReadWithDeadline(Stream stream, int milliseconds) {
        Task<string> read = Task.Factory.StartNew(() => ReadLine(stream));
        if (!read.Wait(milliseconds)) { stream.Dispose(); throw new TimeoutException("pipe_read_timeout"); }
        return read.Result;
    }
    static void WriteLine(Stream stream, string line) {
        byte[] bytes = Utf8.GetBytes(line + "\n");
        if (bytes.Length > MaxFrame + 1) throw new InvalidDataException("frame_too_large");
        stream.Write(bytes, 0, bytes.Length); stream.Flush();
    }
    static bool SameNonce(string candidate) {
        if (candidate == null || candidate.Length != Nonce.Length) return false;
        int difference = 0; for (int i = 0; i < Nonce.Length; i++) difference |= candidate[i] ^ Nonce[i];
        return difference == 0;
    }
    static string RandomHex() {
        byte[] bytes = new byte[32]; using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
        return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    }
    static PipeSecurity PipeAcl() {
        var acl = new PipeSecurity(); acl.SetAccessRuleProtection(true, false);
        acl.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        acl.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        return acl;
    }
    static void AcceptPipes() {
        while (!Closing) {
            NamedPipeServerStream pipe = null;
            try {
                pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 65536, 65536, PipeAcl());
                lock (PipesLock) Pipes.Add(pipe);
                pipe.WaitForConnection();
                var accepted = pipe; new Thread(() => ServeClient(accepted)) { IsBackground = true }.Start();
            } catch {
                if (pipe != null) { lock (PipesLock) Pipes.Remove(pipe); pipe.Dispose(); }
                if (!Closing) Thread.Sleep(25);
            }
        }
    }
    static void ServeClient(NamedPipeServerStream pipe) {
        bool receiver = false, sender = false;
        try {
            using (var input = new BufferedStream(pipe, 65536)) {
                if (!OwnedClient(pipe)) return;
                string authLine = ReadWithDeadline(input, 5000);
                if (authLine == null) return;
                var auth = Obj(authLine);
                string role = Text(auth, "role");
                if (!SameNonce(Text(auth, "nonce")) || (role != "send" && role != "recv")) return;
                if (role == "recv") {
                    if (Interlocked.CompareExchange(ref Receiver, 1, 0) != 0) return;
                    receiver = true;
                } else {
                    // Held until this batch's EOF is fully emitted: a client exits before the host parses its bytes, so a later batch could overtake it.
                    Monitor.TryEnter(SenderLock, SenderWait, ref sender);
                    if (!sender) { WriteLine(pipe, "{\"ok\":false}"); return; }
                }
                WriteLine(pipe, "{\"ok\":true}");
                if (receiver) {
                    // This role sends nothing after authentication. EOF must wake an idle request loop too.
                    Task<int> receiverEnded = input.ReadAsync(new byte[1], 0, 1);
                    receiverEnded.ContinueWith(read => {
                        try { read.GetAwaiter().GetResult(); } catch { /* The connection owner reports one fixed disconnection. */ }
                        lock (QueueLock) Monitor.PulseAll(QueueLock);
                    }, TaskContinuationOptions.ExecuteSynchronously);
                    while (!Closing) {
                        string frame = null;
                        lock (QueueLock) {
                            while (Requests.Count == 0 && !Closing && !receiverEnded.IsCompleted) Monitor.Wait(QueueLock);
                            if (Closing || receiverEnded.IsCompleted) break;
                            if (Requests.Count > 0) {
                                frame = Requests.Dequeue(); QueuedBytes -= Utf8.GetByteCount(frame);
                            }
                        }
                        if (frame != null) WriteLine(pipe, frame);
                    }
                } else {
                    int count = 0; long bytes = 0; string line;
                    while ((line = ReadWithDeadline(input, 10000)) != null) {
                        if (++count > 128 || (bytes += Utf8.GetByteCount(line)) > MaxQueued) throw new InvalidDataException("batch_too_large");
                        var frame = Obj(line);
                        string type = Text(frame, "type");
                        if (type != "hello" && type != "startupError" && type != "event" && type != "response") throw new InvalidDataException("invalid_bridge_frame");
                        if (type == "hello" || type == "startupError") {
                            lock (LifecycleLock) {
                                if (Closing) return;
                                StartupInputClosed = true;
                                Emit(new { kind = "bridge", frame = frame });
                            }
                        } else Emit(new { kind = "bridge", frame = frame });
                    }
                }
            }
        } catch { /* Unauthenticated, abandoned or malformed clients cannot affect the child. */ }
        finally {
            if (sender) Monitor.Exit(SenderLock);
            if (receiver) { Interlocked.Exchange(ref Receiver, 0); if (!Closing) try { Emit(new { kind = "disconnected" }); } catch { } }
            lock (PipesLock) Pipes.Remove(pipe);
            pipe.Dispose();
        }
    }
    static bool OwnedClient(NamedPipeServerStream pipe) {
        uint pid;
        if (Closing || Child == IntPtr.Zero || WaitForSingleObject(Child, 0) != 258 || !GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out pid)) return false;
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return false;
        try {
            var path = new StringBuilder(32768); uint length = (uint)path.Capacity;
            if (!QueryFullProcessImageName(process, 0, path, ref length) || !String.Equals(Path.GetFullPath(path.ToString()), Path.GetFullPath(System.Reflection.Assembly.GetExecutingAssembly().Location), StringComparison.OrdinalIgnoreCase)) return false;
            IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1)) return false;
            try {
                var entry = new PROCESSENTRY32(); entry.dwSize = (uint)Marshal.SizeOf(entry);
                if (!Process32First(snapshot, ref entry)) return false;
                do { if (entry.th32ProcessID == pid) return entry.th32ParentProcessID == ChildPid; } while (Process32Next(snapshot, ref entry));
                return false;
            } finally { CloseHandle(snapshot); }
        } finally { CloseHandle(process); }
    }
    static int Client(string role) {
        string name = Environment.GetEnvironmentVariable("RELAY_NATIVE_PIPE");
        string nonce = Environment.GetEnvironmentVariable("RELAY_NATIVE_NONCE");
        if (String.IsNullOrEmpty(name) || String.IsNullOrEmpty(nonce)) return 2;
        using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut, PipeOptions.Asynchronous)) {
            pipe.Connect(5000);
            WriteLine(pipe, Json(new { role = role, nonce = nonce }));
            using (var input = new BufferedStream(pipe, 65536)) {
                var ack = Obj(ReadWithDeadline(input, 5000));
                if (!ack.ContainsKey("ok") || !(bool)ack["ok"]) return 3;
                if (role == "recv") {
                    using (var stdout = Console.OpenStandardOutput()) {
                        string line; while ((line = ReadLine(input)) != null) WriteLine(stdout, line);
                    }
                } else {
                    using (var stdin = new BufferedStream(Console.OpenStandardInput(), 65536)) {
                        int count = 0; long bytes = 0; string line;
                        while ((line = ReadLine(stdin)) != null) {
                            if (++count > 128 || (bytes += Utf8.GetByteCount(line)) > MaxQueued) return 4;
                            WriteLine(pipe, line);
                        }
                    }
                    // Closing this client is the authenticated finite-batch delimiter.
                }
            }
        }
        return 0;
    }
    static string Quote(string value) {
        if (value.IndexOf('\0') >= 0) throw new ArgumentException("invalid_argument");
        var b = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { b.Append('\\', slashes * 2 + 1); b.Append('"'); }
            else { b.Append('\\', slashes); b.Append(c); }
            slashes = 0;
        }
        b.Append('\\', slashes * 2); return b.Append('"').ToString();
    }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Start(Dictionary<string, object> launch) {
        lock (LifecycleLock) {
            if (Started || Closing) throw new InvalidOperationException("already_started");
            string exe = Text(launch, "exe"), cwd = Text(launch, "cwd");
            if (String.IsNullOrEmpty(exe) || !Path.IsPathRooted(exe) || !File.Exists(exe) || !exe.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("absolute_executable_required");
            if (String.IsNullOrEmpty(cwd) || !Path.IsPathRooted(cwd) || !Directory.Exists(cwd)) throw new ArgumentException("absolute_cwd_required");
            int cols = Number(launch, "cols", 120), rows = Number(launch, "rows", 40);
            if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) throw new ArgumentException("invalid_dimensions");
            var envInput = launch["env"] as Dictionary<string, object>;
            if (envInput == null) throw new ArgumentException("environment_required");
            var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in envInput) {
                if (entry.Value == null) continue;
                string value = Convert.ToString(entry.Value);
                if (entry.Key.Length == 0 || entry.Key.IndexOf('=') >= 0 || entry.Key.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0) throw new ArgumentException("invalid_environment");
                if (env.ContainsKey(entry.Key)) throw new ArgumentException("duplicate_environment_key");
                env.Add(entry.Key, value);
            }
            PipeName = "relay-native-" + RandomHex(); Nonce = RandomHex();
            env["RELAY_NATIVE_PIPE"] = PipeName; env["RELAY_NATIVE_NONCE"] = Nonce;
            env["RELAY_NATIVE_HELPER"] = System.Reflection.Assembly.GetExecutingAssembly().Location;
            var envText = new StringBuilder(); foreach (var entry in env) envText.Append(entry.Key).Append('=').Append(entry.Value).Append('\0'); envText.Append('\0');
            var command = new StringBuilder(Quote(exe));
            var args = launch["args"] as IEnumerable;
            if (args == null) throw new ArgumentException("arguments_required");
            foreach (object argument in args) command.Append(' ').Append(Quote(Convert.ToString(argument)));
            IntPtr inputRead = IntPtr.Zero, outputWrite = IntPtr.Zero, attributes = IntPtr.Zero, environment = IntPtr.Zero;
            PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
            try {
                Check(CreatePipe(out inputRead, out InputWrite, IntPtr.Zero, 0));
                Check(CreatePipe(out OutputRead, out outputWrite, IntPtr.Zero, 0));
                int hr = CreatePseudoConsole(new COORD((short)cols, (short)rows), inputRead, outputWrite, 0, out ConsoleHandle);
                if (hr != 0) Marshal.ThrowExceptionForHR(hr);
                CloseHandle(inputRead); inputRead = IntPtr.Zero; CloseHandle(outputWrite); outputWrite = IntPtr.Zero;
                IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                attributes = Marshal.AllocHGlobal(size); Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
                Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020016), ConsoleHandle, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
                var si = new STARTUPINFOEX(); si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); si.lpAttributeList = attributes;
                Job = CreateJobObject(IntPtr.Zero, null); Check(Job != IntPtr.Zero);
                var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); limits.BasicLimitInformation.LimitFlags = 0x00002000;
                Check(SetInformationJobObject(Job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
                environment = Marshal.StringToHGlobalUni(envText.ToString());
                // Do not copy the GUI helper's redirected Node protocol handles into the console child.
                IntPtr stdin = GetStdHandle(-10), stdout = GetStdHandle(-11), stderr = GetStdHandle(-12);
                try {
                    Check(SetStdHandle(-10, IntPtr.Zero)); Check(SetStdHandle(-11, IntPtr.Zero)); Check(SetStdHandle(-12, IntPtr.Zero));
                    // ConPTY is already windowless. CREATE_NO_WINDOW would detach its real console handles.
                    Check(CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x00000400 | 0x00000004, environment, cwd, ref si, out pi));
                } finally { SetStdHandle(-10, stdin); SetStdHandle(-11, stdout); SetStdHandle(-12, stderr); }
                Child = pi.hProcess; ChildPid = pi.dwProcessId;
                Check(AssignProcessToJobObject(Job, Child));
                Started = true;
                new Thread(AcceptPipes) { IsBackground = true }.Start();
                OutputThread = new Thread(ReadTerminal) { IsBackground = true }; OutputThread.Start();
                Check(ResumeThread(pi.hThread) != 0xffffffff);
                new Thread(WaitForChild) { IsBackground = true }.Start();
            } catch {
                if (pi.hProcess != IntPtr.Zero) { TerminateProcess(pi.hProcess, 127); WaitForSingleObject(pi.hProcess, 5000); }
                Cleanup(); throw;
            } finally {
                if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
                if (inputRead != IntPtr.Zero) CloseHandle(inputRead);
                if (outputWrite != IntPtr.Zero) CloseHandle(outputWrite);
                if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
                if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            }
        }
    }
    static void ReadTerminal() {
        try {
            using (var stream = new FileStream(new SafeFileHandle(OutputRead, false), FileAccess.Read, 65536, false)) {
                byte[] buffer = new byte[65536]; char[] chars = new char[65536]; int n;
                Decoder decoder = Utf8.GetDecoder();
                while ((n = stream.Read(buffer, 0, buffer.Length)) > 0) {
                    int count = decoder.GetChars(buffer, 0, n, chars, 0, false);
                    if (count > 0) Emit(new { kind = "terminal", data = new string(chars, 0, count) });
                }
            }
        } catch (Exception error) { if (!Closing) try { Emit(new { kind = "error", code = "terminal_read_failed", detail = error.GetType().Name }); } catch { } }
    }
    static void WaitForChild() {
        IntPtr child = Child;
        if (WaitForSingleObject(child, 0xffffffff) == 0) {
            uint code; GetExitCodeProcess(child, out code); ChildExited.Set();
            if (Interlocked.Exchange(ref ExitPublished, 1) == 0) try { Emit(new { kind = "exit", code = unchecked((int)code) }); } catch { }
        }
    }
    static void Cleanup() {
        lock (LifecycleLock) {
            if (Closing) return; Closing = true;
            lock (QueueLock) { Requests.Clear(); QueuedBytes = 0; Monitor.PulseAll(QueueLock); }
            lock (PipesLock) { foreach (var pipe in Pipes.ToArray()) try { pipe.Dispose(); } catch { } Pipes.Clear(); }
            if (Job != IntPtr.Zero) { TerminateJobObject(Job, 0); }
            if (Child != IntPtr.Zero) { WaitForSingleObject(Child, 5000); ChildExited.Set(); }
            if (InputWrite != IntPtr.Zero) { CloseHandle(InputWrite); InputWrite = IntPtr.Zero; }
            if (ConsoleHandle != IntPtr.Zero) { ClosePseudoConsole(ConsoleHandle); ConsoleHandle = IntPtr.Zero; }
            if (OutputThread != null) OutputThread.Join(2000);
            if (OutputRead != IntPtr.Zero) { CloseHandle(OutputRead); OutputRead = IntPtr.Zero; }
            if (Child != IntPtr.Zero) { CloseHandle(Child); Child = IntPtr.Zero; }
            if (Job != IntPtr.Zero) { CloseHandle(Job); Job = IntPtr.Zero; }
        }
    }
    static void Handle(Dictionary<string, object> message) {
        string op = Text(message, "op");
        if (op == "start") { Start((Dictionary<string, object>)message["launch"]); return; }
        if (!Started || Closing) throw new InvalidOperationException("not_running");
        if (op == "send") {
            string frame = Json(message["frame"]); int bytes = Utf8.GetByteCount(frame);
            if (bytes > MaxFrame) throw new InvalidDataException("frame_too_large");
            lock (QueueLock) {
                if (Requests.Count >= 128 || QueuedBytes + bytes > MaxQueued) throw new InvalidOperationException("queue_full");
                Requests.Enqueue(frame); QueuedBytes += bytes; Monitor.PulseAll(QueueLock);
            }
        } else if (op == "cancel") {
            lock (QueueLock) {
                string id = Text(message, "requestId", ""); int count = Requests.Count;
                for (int i = 0; i < count; i++) {
                    string frame = Requests.Dequeue();
                    if (Text(Obj(frame), "id", "") == id) QueuedBytes -= Utf8.GetByteCount(frame);
                    else Requests.Enqueue(frame);
                }
            }
        } else if (op == "writeStartup") {
            string key = Text(message, "data", "");
            if (key != "\r" && key != "\x1b[A" && key != "\x1b[B" && key != "\x1b[C" && key != "\x1b[D" && key != "\t" && key != "\x1b") throw new ArgumentException("invalid_startup_key");
            lock (LifecycleLock) {
                if (Closing || StartupInputClosed) throw new InvalidOperationException("startup_input_closed");
                byte[] bytes = Utf8.GetBytes(key); uint written;
                Check(WriteFile(InputWrite, bytes, (uint)bytes.Length, out written, IntPtr.Zero));
                if (written != bytes.Length) throw new IOException("incomplete_startup_write");
            }
        } else if (op == "write") {
            byte[] bytes = Utf8.GetBytes(Text(message, "data", "")); uint written;
            Check(WriteFile(InputWrite, bytes, (uint)bytes.Length, out written, IntPtr.Zero));
            if (written != bytes.Length) throw new IOException("incomplete_terminal_write");
        } else if (op == "resize") {
            int cols = Number(message, "cols", 0), rows = Number(message, "rows", 0);
            if (cols < 1 || cols > 1000 || rows < 1 || rows > 1000) throw new ArgumentException("invalid_dimensions");
            int hr = ResizePseudoConsole(ConsoleHandle, new COORD((short)cols, (short)rows)); if (hr != 0) Marshal.ThrowExceptionForHR(hr);
        } else if (op == "close") Cleanup();
        else throw new ArgumentException("unknown_operation");
    }
    [STAThread] static int Main(string[] args) {
        try {
            if (args.Length == 1 && (args[0] == "recv" || args[0] == "send")) return Client(args[0]);
            if (args.Length != 1 || args[0] != "host") return 2;
            Output = new StreamWriter(Console.OpenStandardOutput(), Utf8) { AutoFlush = true };
            using (var input = new BufferedStream(Console.OpenStandardInput(), 65536)) {
                string line;
                while ((line = ReadLine(input)) != null) {
                    var message = Obj(line); string id = Text(message, "id", "");
                    try { Handle(message); Emit(new { kind = "ack", id = id, ok = true }); }
                    catch (Exception error) {
                        var native = error as Win32Exception;
                        Emit(new { kind = "ack", id = id, ok = false, error = new { code = "native_operation_failed", type = error.GetType().Name, nativeCode = native == null ? 0 : native.NativeErrorCode } });
                    }
                    if (Closing) break;
                }
            }
            return 0;
        } catch { return 1; }
        finally { Cleanup(); }
    }
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; public COORD(short x, short y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESSENTRY32 { public uint dwSize, cntUsage, th32ProcessID; public UIntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, uint size);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetStdHandle(int which, IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetNamedPipeClientProcessId(IntPtr pipe, out uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "QueryFullProcessImageNameW")] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32FirstW")] static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32NextW")] static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll")] static extern int CreatePseudoConsole(COORD size, IntPtr input, IntPtr output, uint flags, out IntPtr console);
    [DllImport("kernel32.dll")] static extern int ResizePseudoConsole(IntPtr console, COORD size);
    [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX info, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr file, byte[] bytes, uint count, out uint written, IntPtr overlapped);
}

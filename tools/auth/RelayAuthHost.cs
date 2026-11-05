using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// No shell, detached keeper, PID search, credential file, user-input interception or output relay: the CLI writes to
// the console itself, and the parent learns only that it started and how it exited.
// Windows 10+ JOB_LIST assignment is atomic with creation, including a host crash during CreateProcess.
// The CLI alone is in a kill-on-close job. What it starts breaks away from that job into a tracking job without limits,
// so the end of a login never kills a windowed program the CLI opened, such as the browser showing the sign-in page, or
// the console programs that program starts, not even when this host is killed. The login's other console processes
// still end with it (EndLogin).
internal sealed class RelayAuthHost : IDisposable
{
    private const uint KillOnJobClose = 0x2000;
    private const uint SilentBreakawayOk = 0x1000;
    private const uint CancelExitCode = 130;
    private const int MaximumStartBytes = 1024 * 1024;
    private const int EndMilliseconds = 3000;
    private readonly object stateLock = new object();
    private readonly object outputLock = new object();
    private readonly ManualResetEvent ended = new ManualResetEvent(false);
    private readonly Native.ConsoleHandler consoleHandler;
    private readonly Stream control;
    private readonly StreamWriter frames;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = MaximumStartBytes };
    private IntPtr job;
    private IntPtr tracking;
    private IntPtr process;
    private bool stopping;
    private bool ending;
    private bool consoleAllocated;

    private RelayAuthHost()
    {
        IntPtr input = Native.GetStdHandle(-10);
        IntPtr output = Native.GetStdHandle(-11);
        Check(Native.SetHandleInformation(input, 1, 0));
        Check(Native.SetHandleInformation(output, 1, 0));
        IntPtr error = Native.GetStdHandle(-12);
        if (error != IntPtr.Zero && error != new IntPtr(-1)) Check(Native.SetHandleInformation(error, 1, 0));
        control = new FileStream(new SafeFileHandle(input, false), FileAccess.Read, 4096, false);
        frames = new StreamWriter(new FileStream(new SafeFileHandle(output, false), FileAccess.Write, 4096, false), new UTF8Encoding(false));
        frames.AutoFlush = true;
        job = Native.CreateJobObject(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = KillOnJobClose | SilentBreakawayOk;
        Check(Native.SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
        tracking = Native.CreateJobObject(IntPtr.Zero, null);
        Check(tracking != IntPtr.Zero);
        consoleHandler = OnConsoleEvent;
    }

    private static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }

    private string ReadStart()
    {
        using (MemoryStream bytes = new MemoryStream())
        {
            for (int count = 0; count <= MaximumStartBytes; count++)
            {
                int value = control.ReadByte();
                if (value < 0) return null;
                if (value == 10) return new UTF8Encoding(false, true).GetString(bytes.ToArray());
                bytes.WriteByte((byte)value);
            }
            throw new InvalidDataException();
        }
    }

    private void WatchParent()
    {
        try { control.ReadByte(); }
        catch (IOException) { }
        // There are no post-start commands. Any byte or EOF revokes the lifetime capability.
        Stop();
    }

    private void Stop()
    {
        lock (stateLock)
        {
            stopping = true;
            if (job != IntPtr.Zero) Native.TerminateJobObject(job, CancelExitCode);
        }
    }

    // Ctrl+C and Ctrl+Break in the login console are the CLI's to handle. Closing that console ends the login like a
    // cancel, within the seconds Windows allows before it ends this process.
    private bool OnConsoleEvent(uint type)
    {
        if (type == 0 || type == 1) return true;
        Stop();
        ended.WaitOne(EndMilliseconds + 500);
        return true;
    }

    // Ends the CLI, then the login's console processes (EndConsoleProcesses). A process without a console, such as a
    // browser, keeps running, and so does every console program it started.
    private void EndLogin()
    {
        if (ending) return;
        ending = true;
        try
        {
            Stop();
            if (process == IntPtr.Zero) return;
            Stopwatch elapsed = Stopwatch.StartNew();
            if (Native.WaitForSingleObject(process, EndMilliseconds) != 0) throw new TimeoutException();
            // AttachConsole works only in a process that has no console.
            if (consoleAllocated) { Native.FreeConsole(); consoleAllocated = false; }
            // A console process that is still starting is attached only moments later, so a few passes must find nothing.
            int quiet = 0;
            while (quiet < 3)
            {
                quiet = EndConsoleProcesses() ? 0 : quiet + 1;
                if (elapsed.ElapsedMilliseconds >= EndMilliseconds) throw new TimeoutException();
                Thread.Sleep(20);
            }
        }
        finally { ended.Set(); }
    }

    // A tracked process during one pass. Its open handle keeps its id from going to another process meanwhile.
    private sealed class Tracked
    {
        internal IntPtr Handle;
        internal long Created;
        internal bool Console;
        internal bool Running;
    }

    // Ends every tracked process attached to a console (the login console, or a hidden one of its own, which is how the
    // CLI starts most helpers), except those a tracked process without a console started, directly or through console
    // processes: a browser the login opened starts a password manager's native messaging host with a hidden console.
    private bool EndConsoleProcesses()
    {
        Dictionary<uint, Tracked> listed = new Dictionary<uint, Tracked>();
        try
        {
            foreach (uint id in TrackedProcessIds())
            {
                IntPtr handle = Native.OpenProcess(0x00101001, false, id);
                if (handle == IntPtr.Zero) continue;
                Tracked item = new Tracked { Handle = handle };
                listed[id] = item;
                bool inJob;
                long exited, kernel, user;
                // A listed process can have exited since, and its id can belong to another process by now.
                if (!Native.IsProcessInJob(handle, tracking, out inJob) || !inJob || !Native.GetProcessTimes(handle, out item.Created, out exited, out kernel, out user)) continue;
                item.Console = Native.AttachConsole(id);
                if (item.Console) Native.FreeConsole();
                item.Running = Native.WaitForSingleObject(handle, 0) != 0;
            }
            Dictionary<uint, uint> parents = ParentIds();
            bool endedOne = false;
            foreach (KeyValuePair<uint, Tracked> entry in listed)
            {
                if (!entry.Value.Running || !entry.Value.Console || StartedWithoutConsole(entry.Key, listed, parents)) continue;
                Native.TerminateProcess(entry.Value.Handle, CancelExitCode);
                Native.WaitForSingleObject(entry.Value.Handle, 1000);
                endedOne = true;
            }
            return endedOne;
        }
        finally { foreach (Tracked item in listed.Values) Native.CloseHandle(item.Handle); }
    }

    // Whether a tracked process without a console started this one, directly or through tracked console processes. A
    // parent counts only while it runs and if it started no later than its child: an id a newer process took over leads
    // nowhere, and the helpers of a parent that has exited still end.
    private static bool StartedWithoutConsole(uint id, Dictionary<uint, Tracked> listed, Dictionary<uint, uint> parents)
    {
        Tracked child = listed[id];
        for (int depth = 0; depth < listed.Count; depth++)
        {
            uint parentId;
            Tracked parent;
            if (!parents.TryGetValue(id, out parentId) || !listed.TryGetValue(parentId, out parent) || !parent.Running || parent.Created > child.Created) return false;
            if (!parent.Console) return true;
            id = parentId;
            child = parent;
        }
        return false;
    }

    // Parent links only: whatever this host ends, it holds by a handle from its tracking job. Taken while those handles
    // are open, so none of their ids can name another process yet.
    private static Dictionary<uint, uint> ParentIds()
    {
        Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
        IntPtr snapshot = Native.CreateToolhelp32Snapshot(2, 0);
        Check(snapshot != new IntPtr(-1));
        try
        {
            Native.PROCESSENTRY32 entry = new Native.PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32));
            for (bool more = Native.Process32First(snapshot, ref entry); more; more = Native.Process32Next(snapshot, ref entry)) parents[entry.th32ProcessID] = entry.th32ParentProcessID;
        }
        finally { Native.CloseHandle(snapshot); }
        return parents;
    }

    private uint[] TrackedProcessIds()
    {
        for (int capacity = 64; ; capacity *= 4)
        {
            int size = 8 + capacity * IntPtr.Size;
            IntPtr list = Marshal.AllocHGlobal(size);
            try
            {
                if (Native.QueryInformationJobObject(tracking, 3, list, (uint)size, IntPtr.Zero))
                {
                    uint[] ids = new uint[Marshal.ReadInt32(list, 4)];
                    for (int index = 0; index < ids.Length; index++) ids[index] = (uint)Marshal.ReadIntPtr(list, 8 + index * IntPtr.Size).ToInt64();
                    return ids;
                }
                int error = Marshal.GetLastWin32Error();
                if (error != 234) throw new Win32Exception(error);
            }
            finally { Marshal.FreeHGlobal(list); }
        }
    }

    private bool Send(object frame)
    {
        try { lock (outputLock) frames.WriteLine(json.Serialize(frame)); return true; }
        catch (IOException) { Stop(); return false; }
        catch (ObjectDisposedException) { Stop(); return false; }
    }

    private static string Text(Dictionary<string, object> request, string key)
    {
        object value;
        if (!request.TryGetValue(key, out value) || !(value is string) || ((string)value).IndexOf('\0') >= 0) throw new InvalidDataException();
        return (string)value;
    }

    private static string LocalPath(Dictionary<string, object> request, string key)
    {
        string path = Text(request, key);
        if (path.Length < 3 || path.Length > 1024 || !Char.IsLetter(path[0]) || path[1] != ':' || (path[2] != '\\' && path[2] != '/')) throw new InvalidDataException();
        foreach (string part in path.Substring(3).Split('\\', '/')) if (part == "..") throw new InvalidDataException();
        return path;
    }

    private static string Quote(string value)
    {
        if (value.Length > 0 && value.IndexOfAny(new char[] { ' ', '\t', '\r', '\n', '\v', '"' }) < 0) return value;
        StringBuilder result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            result.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
            result.Append(ch);
            slashes = 0;
        }
        result.Append('\\', slashes * 2);
        return result.Append('"').ToString();
    }

    private static string EnvironmentBlock(Dictionary<string, object> request)
    {
        Dictionary<string, object> supplied = request["env"] as Dictionary<string, object>;
        if (supplied == null) throw new InvalidDataException();
        SortedDictionary<string, string> sorted = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (KeyValuePair<string, object> pair in supplied)
        {
            if (pair.Key.Length == 0 || pair.Key.IndexOfAny(new char[] { '=', '\0' }) >= 0 || !(pair.Value is string) || ((string)pair.Value).IndexOf('\0') >= 0) throw new InvalidDataException();
            sorted[pair.Key] = (string)pair.Value;
        }
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> pair in sorted) block.Append(pair.Key).Append('=').Append(pair.Value).Append('\0');
        if (sorted.Count == 0) block.Append('\0');
        return block.Append('\0').ToString();
    }

    private uint Run(Dictionary<string, object> request)
    {
        if (!request.ContainsKey("protocol") || !Object.Equals(request["protocol"], 1)) throw new InvalidDataException();
        string exe = LocalPath(request, "exe");
        string cwd = LocalPath(request, "cwd");
        string title = Text(request, "title");
        bool visible = request.ContainsKey("visible") && request["visible"] is bool && (bool)request["visible"];
        // There is no relay mode; a request that does not state that is refused.
        if (!request.ContainsKey("relayOutput") || !Object.Equals(request["relayOutput"], false)) throw new InvalidDataException();
        object[] args = request["args"] as object[];
        if (args == null) throw new InvalidDataException();
        StringBuilder command = new StringBuilder(Quote(exe));
        foreach (object arg in args)
        {
            if (!(arg is string) || ((string)arg).IndexOf('\0') >= 0) throw new InvalidDataException();
            command.Append(' ').Append(Quote((string)arg));
        }
        if (command.Length >= 32767) throw new InvalidDataException();
        string environment = EnvironmentBlock(request);
        Thread watcher = new Thread(WatchParent);
        watcher.IsBackground = true;
        watcher.Start();

        IntPtr input = IntPtr.Zero, inputWriter = IntPtr.Zero;
        IntPtr childOutput = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero, inherited = IntPtr.Zero, jobList = IntPtr.Zero, env = IntPtr.Zero;
        IntPtr primaryThread = IntPtr.Zero;
        bool attributesInitialized = false;
        try
        {
            Native.SECURITY_ATTRIBUTES security = new Native.SECURITY_ATTRIBUTES();
            security.nLength = Marshal.SizeOf(security);
            security.bInheritHandle = true;
            // A login cancelled this early never shows its console.
            lock (stateLock) { if (stopping) return CancelExitCode; }
            if (visible)
            {
                Check(Native.AllocConsole());
                consoleAllocated = true;
                Check(Native.SetConsoleCtrlHandler(consoleHandler, true));
                // Node starts this GUI helper hidden. AllocConsole inherits that show state;
                // show only the console just allocated here, without activating/focusing it.
                IntPtr consoleWindow = Native.GetConsoleWindow();
                Check(consoleWindow != IntPtr.Zero);
                Native.ShowWindow(consoleWindow, 4);
                Check(Native.IsWindowVisible(consoleWindow));
                Check(Native.SetConsoleTitle(title));
                Check(Native.SetConsoleOutputCP(65001));
                Check(Native.SetConsoleCP(65001));
                input = Native.CreateFile("CONIN$", 0xC0000000, 3, ref security, 3, 0, IntPtr.Zero);
                Check(input != new IntPtr(-1));
                Native.SECURITY_ATTRIBUTES privateSecurity = new Native.SECURITY_ATTRIBUTES();
                privateSecurity.nLength = Marshal.SizeOf(privateSecurity);
                IntPtr screen = Native.CreateFile("CONOUT$", 0xC0000000, 3, ref privateSecurity, 3, 0, IntPtr.Zero);
                Check(screen != new IntPtr(-1));
                try
                {
                    uint consoleMode;
                    Check(Native.GetConsoleMode(screen, out consoleMode));
                    Check(Native.SetConsoleMode(screen, consoleMode | 4));
                }
                finally { Close(ref screen); }
            }
            else
            {
                Check(Native.CreatePipe(out input, out inputWriter, ref security, 0));
                Check(Native.SetHandleInformation(inputWriter, 1, 0));
            }
            // The CLI writes to the visible console itself; headless (tests only) its output goes nowhere.
            childOutput = Native.CreateFile(visible ? "CONOUT$" : "NUL", 0xC0000000, 3, ref security, 3, 0, IntPtr.Zero);
            Check(childOutput != new IntPtr(-1));
            IntPtr size = IntPtr.Zero;
            Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
            attributeList = Marshal.AllocHGlobal(size);
            Check(Native.InitializeProcThreadAttributeList(attributeList, 2, 0, ref size));
            attributesInitialized = true;
            inherited = Marshal.AllocHGlobal(2 * IntPtr.Size);
            Marshal.Copy(new IntPtr[] { input, childOutput }, 0, inherited, 2);
            Check(Native.UpdateProcThreadAttribute(attributeList, 0, new IntPtr(0x20002), inherited, new IntPtr(2 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            // In this order the kill-on-close job is nested in the tracking job, which keeps what the CLI starts.
            jobList = Marshal.AllocHGlobal(2 * IntPtr.Size);
            Marshal.Copy(new IntPtr[] { tracking, job }, 0, jobList, 2);
            Check(Native.UpdateProcThreadAttribute(attributeList, 0, new IntPtr(0x2000D), jobList, new IntPtr(2 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
            env = Marshal.StringToHGlobalUni(environment);
            Native.STARTUPINFOEX startup = new Native.STARTUPINFOEX();
            startup.StartupInfo.cb = Marshal.SizeOf(startup);
            startup.StartupInfo.dwFlags = 0x100;
            startup.StartupInfo.hStdInput = input;
            startup.StartupInfo.hStdOutput = childOutput;
            startup.StartupInfo.hStdError = childOutput;
            startup.lpAttributeList = attributeList;
            Native.PROCESS_INFORMATION created;
            lock (stateLock)
            {
                if (stopping) return CancelExitCode;
                uint flags = 0x4 | 0x400 | 0x80000;
                if (!visible) flags |= 0x08000000;
                Check(Native.CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, true, flags, env, cwd, ref startup, out created));
                process = created.hProcess;
                primaryThread = created.hThread;
                // JOB_LIST assigned it before CreateProcess returned; there is no unowned suspended interval.
                bool inJob, tracked;
                Check(Native.IsProcessInJob(process, job, out inJob) && inJob);
                Check(Native.IsProcessInJob(process, tracking, out tracked) && tracked);
            }
#if AUTH_HOST_TESTS
            // Only the isolated test compiler defines this. The released binary has no pause protocol.
            if (request.ContainsKey("testPauseAfterCreate") && Object.Equals(request["testPauseAfterCreate"], true))
            {
                Send(new { type = "test-created", pid = created.dwProcessId, console = Native.GetConsoleWindow().ToInt64() });
                Stopwatch pause = Stopwatch.StartNew();
                while (pause.ElapsedMilliseconds < 5000)
                {
                    lock (stateLock) { if (stopping) return CancelExitCode; }
                    Thread.Sleep(10);
                }
                throw new TimeoutException();
            }
#endif
            lock (stateLock)
            {
                if (stopping) return CancelExitCode;
                Check(Native.ResumeThread(primaryThread) != 0xffffffff);
            }
            Close(ref primaryThread);
            Close(ref input);
            Close(ref childOutput);
            Send(new { type = "ready", protocol = 1, pid = created.dwProcessId });
            Check(Native.WaitForSingleObject(process, 0xffffffff) == 0);
            uint code;
            Check(Native.GetExitCodeProcess(process, out code));
            // A normally-exited CLI can still leave console helpers writing auth state.
            EndLogin();
            Send(new { type = "exit", code = code });
            return code;
        }
        finally
        {
            try { EndLogin(); }
            finally
            {
                Close(ref primaryThread);
                Close(ref input); Close(ref inputWriter);
                Close(ref childOutput);
                if (attributesInitialized) Native.DeleteProcThreadAttributeList(attributeList);
                if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
                if (inherited != IntPtr.Zero) Marshal.FreeHGlobal(inherited);
                if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
                if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
            }
        }
    }

    private static void Close(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero && handle != new IntPtr(-1)) Native.CloseHandle(handle);
        handle = IntPtr.Zero;
    }

    public void Dispose()
    {
        Stop();
        lock (stateLock) { Close(ref job); }
        Close(ref tracking);
        Close(ref process);
        if (consoleAllocated) Native.FreeConsole();
        // A background lifetime read can remain blocked while the parent is alive; process exit closes it.
    }

    [STAThread]
    private static int Main()
    {
        RelayAuthHost host = null;
        try
        {
            host = new RelayAuthHost();
            string start = host.ReadStart();
            if (start == null) return (int)CancelExitCode;
            Dictionary<string, object> request = host.json.DeserializeObject(start) as Dictionary<string, object>;
            if (request == null) throw new InvalidDataException();
            return unchecked((int)host.Run(request));
        }
        catch (Exception)
        {
            if (host != null) host.Send(new { type = "error", code = "host_failure" });
            return 1;
        }
        finally { if (host != null) host.Dispose(); }
    }

    private static class Native
    {
        [StructLayout(LayoutKind.Sequential)] internal struct SECURITY_ATTRIBUTES { internal int nLength; internal IntPtr lpSecurityDescriptor; [MarshalAs(UnmanagedType.Bool)] internal bool bInheritHandle; }
        [StructLayout(LayoutKind.Sequential)] internal struct STARTUPINFO { internal int cb; internal IntPtr lpReserved, lpDesktop, lpTitle; internal uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; internal ushort wShowWindow, cbReserved2; internal IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
        [StructLayout(LayoutKind.Sequential)] internal struct STARTUPINFOEX { internal STARTUPINFO StartupInfo; internal IntPtr lpAttributeList; }
        [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION { internal IntPtr hProcess, hThread; internal uint dwProcessId, dwThreadId; }
        [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION { internal long PerProcessUserTimeLimit, PerJobUserTimeLimit; internal uint LimitFlags; internal UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; internal uint ActiveProcessLimit; internal UIntPtr Affinity; internal uint PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] internal struct IO_COUNTERS { internal ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { internal JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; internal IO_COUNTERS IoInfo; internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct PROCESSENTRY32 { internal uint dwSize, cntUsage, th32ProcessID; internal IntPtr th32DefaultHeapID; internal uint th32ModuleID, cntThreads, th32ParentProcessID; internal int pcPriClassBase; internal uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string szExeFile; }
        [UnmanagedFunctionPointer(CallingConvention.Winapi)] [return: MarshalAs(UnmanagedType.Bool)] internal delegate bool ConsoleHandler(uint type);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr GetStdHandle(int standard);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetInformationJobObject(IntPtr job, int informationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length, IntPtr returned);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint id);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsProcessInJob(IntPtr process, IntPtr job, [MarshalAs(UnmanagedType.Bool)] out bool result);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES attributes, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, [MarshalAs(UnmanagedType.Bool)] bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AllocConsole();
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool FreeConsole();
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool AttachConsole(uint id);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetConsoleCtrlHandler(ConsoleHandler handler, [MarshalAs(UnmanagedType.Bool)] bool add);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetConsoleTitle(string title);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetConsoleOutputCP(uint codePage);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetConsoleCP(uint codePage);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint disposition, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetConsoleMode(IntPtr console, out uint mode);
        [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetConsoleMode(IntPtr console, uint mode);
        [DllImport("kernel32.dll")] internal static extern IntPtr GetConsoleWindow();
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ShowWindow(IntPtr window, int command);
        [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool IsWindowVisible(IntPtr window);
    }
}

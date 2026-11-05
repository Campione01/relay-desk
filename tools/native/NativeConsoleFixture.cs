using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Synthetic console only. It never loads Claude, credentials, fonts or network clients.
internal static class NativeConsoleFixture {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32 * 1024 * 1024 };
    static string Session;
    static Process Receiver;
    static readonly object SendLock = new object();
    static void Send(object frame) {
        lock (SendLock) {
            var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("RELAY_NATIVE_HELPER"), "send") {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (var process = Process.Start(info)) {
                using (var writer = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false))) {
                    writer.WriteLine(Json.Serialize(frame));
                }
                if (!process.WaitForExit(8000)) { process.Kill(); throw new Exception("send timeout"); }
                if (process.ExitCode != 0) throw new Exception("send failed: " + process.ExitCode);
            }
        }
    }
    static object Inspect(string[] args) {
        uint inputMode, outputMode; CONSOLE_SCREEN_BUFFER_INFO screen;
        bool inputTty = GetConsoleMode(GetStdHandle(-10), out inputMode);
        bool outputTty = GetConsoleMode(GetStdHandle(-11), out outputMode);
        bool hasScreen = GetConsoleScreenBufferInfo(GetStdHandle(-11), out screen);
        return new {
            inputTty = inputTty, outputTty = outputTty, visibleWindow = IsWindowVisible(GetConsoleWindow()),
            cols = hasScreen ? screen.Window.Right - screen.Window.Left + 1 : 0,
            rows = hasScreen ? screen.Window.Bottom - screen.Window.Top + 1 : 0,
            arguments = args, pid = Process.GetCurrentProcess().Id, receiverPid = Receiver == null ? 0 : Receiver.Id,
            proxy = Environment.GetEnvironmentVariable("HTTPS_PROXY"),
            certificate = Environment.GetEnvironmentVariable("NODE_EXTRA_CA_CERTS"),
            entrypoint = Environment.GetEnvironmentVariable("CLAUDE_CODE_ENTRYPOINT"),
            unicode = Environment.GetEnvironmentVariable("FIXTURE_UNICODE"),
            // Synthetic test explicitly needs pipe metadata to verify authentication/DACL.
            pipe = Environment.GetEnvironmentVariable("RELAY_NATIVE_PIPE"),
            nonce = Environment.GetEnvironmentVariable("RELAY_NATIVE_NONCE")
        };
    }
    static object SecurityProbe() {
        bool protectedAcl = false, correctAllow = false, rejectsNetwork = false;
        string name = Environment.GetEnvironmentVariable("RELAY_NATIVE_PIPE");
        using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut)) {
            pipe.Connect(5000);
            var acl = pipe.GetAccessControl(); protectedAcl = acl.AreAccessRulesProtected;
            int allowed = 0; bool known = true;
            var user = WindowsIdentity.GetCurrent().User;
            var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            var network = new SecurityIdentifier(WellKnownSidType.NetworkSid, null);
            foreach (PipeAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
                if (rule.AccessControlType == AccessControlType.Allow) { allowed++; known &= rule.IdentityReference.Equals(user) || rule.IdentityReference.Equals(system); }
                if (rule.AccessControlType == AccessControlType.Deny && rule.IdentityReference.Equals(network)) rejectsNetwork = true;
            }
            correctAllow = known && allowed == 2;
        }
        // The caller has the capability here, but its image is not the helper: reject it.
        bool rejectsWrongImage = false;
        using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.InOut)) {
            pipe.Connect(5000);
            try {
                byte[] auth = Encoding.UTF8.GetBytes(Json.Serialize(new { role = "send", nonce = Environment.GetEnvironmentVariable("RELAY_NATIVE_NONCE") }) + "\n");
                pipe.Write(auth, 0, auth.Length); pipe.Flush(); rejectsWrongImage = pipe.ReadByte() < 0;
            } catch (IOException) { rejectsWrongImage = true; }
        }
        var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("RELAY_NATIVE_HELPER"), "send") {
            UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        info.EnvironmentVariables["RELAY_NATIVE_NONCE"] = new string('0', 64);
        bool rejectsBadNonce;
        using (var process = Process.Start(info)) {
            try { process.StandardInput.WriteLine("{}"); process.StandardInput.Close(); } catch (IOException) { }
            if (!process.WaitForExit(8000)) { process.Kill(); throw new Exception("bad nonce probe timeout"); }
            rejectsBadNonce = process.ExitCode != 0;
        }
        return new { protectedAcl = protectedAcl, correctAllow = correctAllow, rejectsNetwork = rejectsNetwork, rejectsWrongImage = rejectsWrongImage, rejectsBadNonce = rejectsBadNonce };
    }
    static int Main(string[] args) {
        if (Array.IndexOf(args, "--descendant") >= 0) { Thread.Sleep(Timeout.Infinite); return 0; }
        Session = Guid.NewGuid().ToString();
        try {
            if (Array.IndexOf(args, "--deferred-hello") >= 0) {
                Console.WriteLine("FIXTURE-EXPLICIT-TRUST");
                if (Console.ReadLine() != "ALLOW-FIXTURE") return 97;
            }
            bool badHello = Array.IndexOf(args, "--bad-hello") >= 0;
            var info = new ProcessStartInfo(Environment.GetEnvironmentVariable("RELAY_NATIVE_HELPER"), "recv") {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true
            };
            Receiver = Process.Start(info);
            Send(new { type = "hello", protocol = 1, sessionId = Session, isInteractive = !badHello, surface = "terminal", capabilities = new[] { "inspect", "echo", "events", "exit" } });
            new Thread(() => {
                try {
                    string line;
                    while ((line = Receiver.StandardOutput.ReadLine()) != null) {
                        var request = Json.Deserialize<Dictionary<string, object>>(line);
                        string id = Convert.ToString(request["id"]), method = Convert.ToString(request["method"]);
                        object value = null;
                        if (method == "hang") continue;
                        if (method == "inspect") value = Inspect(args);
                        else if (method == "security") value = SecurityProbe();
                        else if (method == "descendant") {
                            var descendant = new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "--descendant") {
                                UseShellExecute = false, CreateNoWindow = true,
                                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
                            };
                            using (var process = Process.Start(descendant)) value = process.Id;
                        }
                        else if (method == "echo") { request.TryGetValue("args", out value); }
                        else if (method == "events") {
                            Send(new { type = "event", sessionId = Session, sequence = 1, @event = "fixture", data = "first" });
                            Send(new { type = "event", sessionId = Session, sequence = 1, @event = "fixture", data = "duplicate" });
                            Send(new { type = "event", sessionId = "stale", sequence = 2, @event = "fixture", data = "stale" });
                            Send(new { type = "event", sessionId = Session, sequence = 2, @event = "fixture", data = "second" });
                        } else if (method == "late") {
                            Thread.Sleep(250); value = "late";
                        } else if (method == "exit") {
                            Send(new { type = "response", id = id, ok = true, value = "exiting" });
                            Environment.Exit(7);
                        }
                        Send(new { type = "response", id = "stale-id", ok = true, value = "wrong" });
                        Send(new { type = "response", id = id, ok = true, value = value });
                    }
                } catch (Exception error) { Console.Error.WriteLine("FIXTURE-ERROR:" + error.GetType().Name + ":" + error.Message); Environment.Exit(99); }
            }) { IsBackground = true }.Start();
            Console.WriteLine("FIXTURE-READY");
            string terminal;
            while ((terminal = Console.ReadLine()) != null) Console.WriteLine("TERMINAL-ECHO:" + terminal);
            return 0;
        } catch { return 98; }
        finally { if (Receiver != null) Receiver.Dispose(); }
    }
    [StructLayout(LayoutKind.Sequential)] struct COORD { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] struct SMALL_RECT { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct CONSOLE_SCREEN_BUFFER_INFO { public COORD Size, CursorPosition; public short Attributes; public SMALL_RECT Window; public COORD MaximumWindowSize; }
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out CONSOLE_SCREEN_BUFFER_INFO info);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
}

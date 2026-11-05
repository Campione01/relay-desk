using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Isolated synthetic fixture. It never reads credentials, talks to a network, or opens a console.
internal static class FakeAuthProcess
{
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int standard);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetConsoleTitle(StringBuilder title, uint size);
    [DllImport("kernel32.dll")] private static extern uint GetConsoleProcessList(uint[] processes, uint count);
    [DllImport("kernel32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetConsoleMode(IntPtr console, out uint mode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool WriteConsoleInput(IntPtr console, INPUT_RECORD[] records, uint count, out uint written);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    [StructLayout(LayoutKind.Sequential)] private struct RECT { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Explicit, CharSet = CharSet.Unicode)] private struct INPUT_RECORD
    {
        [FieldOffset(0)] internal ushort EventType;
        [FieldOffset(4)] internal int KeyDown;
        [FieldOffset(8)] internal ushort RepeatCount;
        [FieldOffset(10)] internal ushort VirtualKey;
        [FieldOffset(12)] internal ushort ScanCode;
        [FieldOffset(14)] internal char Character;
        [FieldOffset(16)] internal uint ControlState;
    }
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static void Marker(string directory, string role, object record)
    {
        string path = Path.Combine(directory, role + ".json");
        File.WriteAllText(path + ".tmp", Json.Serialize(record));
        File.Move(path + ".tmp", path);
    }

    private static int Interactive(string directory, string expectedTitle)
    {
        if (!Directory.Exists(directory) || !expectedTitle.StartsWith("Relay Owned Auth Synthetic ", StringComparison.Ordinal)) return 2;
        IntPtr window = GetConsoleWindow();
        IntPtr input = GetStdHandle(-10);
        StringBuilder title = new StringBuilder(256);
        GetConsoleTitle(title, (uint)title.Capacity);
        uint[] attached = new uint[16];
        uint attachedCount = GetConsoleProcessList(attached, (uint)attached.Length);
        int pid = Process.GetCurrentProcess().Id;
        bool ownConsole = window != IntPtr.Zero && title.ToString() == expectedTitle &&
            attachedCount == 2 && Array.IndexOf(attached, (uint)pid) >= 0;
        uint mode;
        bool nativeInput = GetConsoleMode(input, out mode);
        if (!ownConsole || !nativeInput || Console.IsInputRedirected)
        {
            Console.WriteLine(Json.Serialize(new { ownConsole = ownConsole, nativeInput = nativeInput, stdinRedirected = Console.IsInputRedirected }));
            return 3;
        }
        // Never SendInput/SendKeys, focus changes, another process's console, or real auth material.
        const string expected = "synthetic-code#synthetic-state";
        string typed = expected + "\r";
        INPUT_RECORD[] records = new INPUT_RECORD[typed.Length * 2];
        for (int index = 0; index < typed.Length; index++)
        {
            for (int edge = 0; edge < 2; edge++)
            {
                INPUT_RECORD record = new INPUT_RECORD();
                record.EventType = 1;
                record.KeyDown = edge == 0 ? 1 : 0;
                record.RepeatCount = 1;
                record.VirtualKey = typed[index] == '\r' ? (ushort)13 : (ushort)0;
                record.Character = typed[index];
                records[index * 2 + edge] = record;
            }
        }
        Console.WriteLine("Synthetic console input test. No real login is running.");
        uint written;
        if (!WriteConsoleInput(input, records, (uint)records.Length, out written) || written != records.Length) return 4;
        bool matched;
        using (Timer watchdog = new Timer(delegate { Environment.Exit(91); }, null, 5000, Timeout.Infinite))
        {
            matched = Console.ReadLine() == expected;
        }
        RECT rectangle;
        bool hasRectangle = GetWindowRect(window, out rectangle);
        object evidence = new
        {
            pid = pid, console = window.ToInt64(), visible = IsWindowVisible(window), minimized = IsIconic(window),
            stdinRedirected = Console.IsInputRedirected, nativeInput = nativeInput, ownConsole = ownConsole,
            attachedCount = attachedCount, inputMatched = matched, inputEvents = written,
            width = hasRectangle ? rectangle.Right - rectangle.Left : 0,
            height = hasRectangle ? rectangle.Bottom - rectangle.Top : 0
        };
        ProcessStartInfo grandchild = new ProcessStartInfo();
        grandchild.FileName = typeof(FakeAuthProcess).Assembly.Location;
        grandchild.Arguments = "grandchild \"" + directory + "\" wait";
        grandchild.UseShellExecute = false;
        grandchild.CreateNoWindow = true;
        Process.Start(grandchild);
        Marker(directory, "interactive", evidence);
        Console.WriteLine(Json.Serialize(evidence));
        Stopwatch deadline = Stopwatch.StartNew();
        while (deadline.ElapsedMilliseconds < 12000) Thread.Sleep(25);
        return matched ? 0 : 5;
    }

    // A login CLI's descendants: a helper with a hidden console of its own (how the CLI starts most helpers), one on the
    // CLI's console, one whose launcher has exited, one that started another on its console, and a windowed program
    // standing in for the browser.
    private static int Family(string directory, string mode, string windowedPath)
    {
        if (!Directory.Exists(directory) || (mode != "early" && mode != "wait")) return 2;
        string self = typeof(FakeAuthProcess).Assembly.Location;
        Process launcher = Start(self, "launcher", directory, true);
        Process[] started = { Start(self, "grandchild", directory, true), Start(self, "sharer", directory, false), Start(self, "relay", directory, true),
            Start(windowedPath, "windowed", directory, false, self) };
        if (!launcher.WaitForExit(5000)) return 4;
        Await(directory, "grandchild", "sharer", "orphan", "relay", "nested", "windowed", "messaging", "nmh");
        GC.KeepAlive(started);
        // Last, so a test that sees it knows the whole family runs and the launcher is gone.
        Marker(directory, "child", new { pid = Process.GetCurrentProcess().Id, console = GetConsoleWindow().ToInt64() });
        return mode == "early" ? 23 : Beat(directory, "child");
    }

    private static void Await(string directory, params string[] roles)
    {
        DateTime deadline = DateTime.UtcNow.AddSeconds(5);
        foreach (string role in roles)
        {
            while (!File.Exists(Path.Combine(directory, role + ".json")) && DateTime.UtcNow < deadline) Thread.Sleep(10);
        }
    }

    private static Process Start(string file, string role, string directory, bool ownConsole, string extra = null)
    {
        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = file;
        start.Arguments = role + " \"" + directory + "\" wait" + (extra == null ? "" : " \"" + extra + "\"");
        start.UseShellExecute = false;
        start.CreateNoWindow = ownConsole;
        return Process.Start(start);
    }

    // The windowed build has no console, so it sets no console encoding. It starts console programs the way a browser
    // starts a native messaging host: through a program with a hidden console of its own ("messaging"), which starts the
    // host on that console ("nmh").
    private static int Windowed(string directory, string consolePath)
    {
        if (!Directory.Exists(directory)) return 2;
        Marker(directory, "windowed", new { pid = Process.GetCurrentProcess().Id, console = GetConsoleWindow().ToInt64() });
        GC.KeepAlive(Start(consolePath, "messaging", directory, true));
        return Beat(directory, "windowed");
    }

    // Starts a program on its own console. "launcher" then exits, so its "orphan" has no parent left; it leaves no marker,
    // so no test holds its id. "relay" (the CLI's, with "nested") and "messaging" (the browser's, with "nmh") stay.
    private static int Starter(string directory, string role)
    {
        if (!Directory.Exists(directory)) return 2;
        string started = role == "launcher" ? "orphan" : role == "relay" ? "nested" : "nmh";
        GC.KeepAlive(Start(typeof(FakeAuthProcess).Assembly.Location, started, directory, false));
        Await(directory, started);
        if (role == "launcher") return 0;
        Marker(directory, role, new { pid = Process.GetCurrentProcess().Id, console = GetConsoleWindow().ToInt64() });
        return Beat(directory, role);
    }

    private static int Beat(string directory, string role)
    {
        DateTime end = DateTime.UtcNow.AddSeconds(12);
        int writes = 0;
        do
        {
            File.WriteAllText(Path.Combine(directory, role + ".heartbeat"), (++writes).ToString());
            Thread.Sleep(25);
        } while (DateTime.UtcNow < end && !File.Exists(Path.Combine(directory, "stop")));
        return 0;
    }

    private static int Main(string[] args)
    {
        if (args.Length == 4 && args[0] == "windowed") return Windowed(Path.GetFullPath(args[1]), args[3]);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 0) return 2;
        if (args.Length == 4 && args[0] == "family") return Family(Path.GetFullPath(args[1]), args[2], args[3]);
        if (args.Length == 3 && (args[0] == "launcher" || args[0] == "relay" || args[0] == "messaging")) return Starter(Path.GetFullPath(args[1]), args[0]);
        if (args.Length == 2 && args[0] == "window-status")
        {
            IntPtr window = new IntPtr(Int64.Parse(args[1]));
            Console.WriteLine(Json.Serialize(new { exists = IsWindow(window), visible = IsWindowVisible(window), ownConsole = GetConsoleWindow().ToInt64() }));
            return 0;
        }
        if (args.Length == 3 && args[0] == "interactive") return Interactive(Path.GetFullPath(args[1]), args[2]);
        if (args[0] == "echo")
        {
            Marker(Environment.CurrentDirectory, "echo", new { pid = Process.GetCurrentProcess().Id, args = args, marker = Environment.GetEnvironmentVariable("RELAY_FAKE_MARKER"), console = GetConsoleWindow().ToInt64(), stdinRedirected = Console.IsInputRedirected });
            Console.WriteLine(Json.Serialize(new { args = args, marker = Environment.GetEnvironmentVariable("RELAY_FAKE_MARKER"), console = GetConsoleWindow().ToInt64(), stdinRedirected = Console.IsInputRedirected }));
            byte[] unicode = new UTF8Encoding(false).GetBytes("stderr:\u4e2d\u6587\ud83d\ude80\n");
            Stream error = Console.OpenStandardError();
            foreach (byte value in unicode) { error.WriteByte(value); error.Flush(); Thread.Sleep(2); }
            return 7;
        }
        if (args.Length != 3 || (args[0] != "tree" && args[0] != "grandchild" && args[0] != "sharer" && args[0] != "orphan" && args[0] != "nested" && args[0] != "nmh" && args[0] != "sentinel")) return 2;
        string directory = Path.GetFullPath(args[1]);
        string role = args[0] == "tree" ? "child" : args[0];
        if (!Directory.Exists(directory)) return 2;
        Marker(directory, role, new { pid = Process.GetCurrentProcess().Id, console = GetConsoleWindow().ToInt64() });
        Console.WriteLine("fake-ready:" + role);
        if (role == "child")
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = typeof(FakeAuthProcess).Assembly.Location;
            start.Arguments = "grandchild \"" + directory + "\" " + args[2];
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            Process grandchild = Process.Start(start);
            DateTime deadline = DateTime.UtcNow.AddSeconds(3);
            while (!File.Exists(Path.Combine(directory, "grandchild.json")) && DateTime.UtcNow < deadline) Thread.Sleep(10);
            if (args[2] == "early") return 23;
            GC.KeepAlive(grandchild);
        }
        DateTime end = DateTime.UtcNow.AddSeconds(12);
        int writes = 0;
        do
        {
            File.WriteAllText(Path.Combine(directory, role + ".heartbeat"), (++writes).ToString());
            Thread.Sleep(25);
        } while (DateTime.UtcNow < end && !File.Exists(Path.Combine(directory, "stop")));
        return 0;
    }
}

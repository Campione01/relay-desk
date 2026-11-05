using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// GUI subsystem, one bounded stdin request, no child process or persistent server.
internal static class RelayPrivateStorage {
    const string Boundary = @"C:\RelayDeskNativePrototype";
    const int MaxInput = 28 * 1024 * 1024;
    const int MaxJson = 1024 * 1024, MaxImage = 5 * 1024 * 1024, MaxAttachments = 20 * 1024 * 1024;
    const string OperationLock = "private-operation.lock";
    const string StateName = "assets-manifest.json";
    const uint ReadControl = 0x20000, Synchronize = 0x100000, ReadAttributes = 0x80, Delete = 0x10000;
    const uint BaseAccess = ReadControl | Synchronize | ReadAttributes;
    const uint DirectoryOptions = 0x1 | 0x20 | 0x200000;
    const uint FileOptions = 0x40 | 0x20 | 0x200000;
    const int FullControl = 0x1f01ff;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly string UserSid = WindowsIdentity.GetCurrent().User.Value;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxInput, RecursionLimit = 48 };

    sealed class Refusal : Exception { internal readonly string Code; internal Refusal(string code) { Code = code; } }
    static void Require(bool value, string code) { if (!value) throw new Refusal(code); }
    static Dictionary<string, object> Object(object value) {
        var result = value as Dictionary<string, object>; Require(result != null, "invalid_request"); return result;
    }
    static object Field(Dictionary<string, object> value, string key) {
        object result; Require(value.TryGetValue(key, out result), "invalid_request"); return result;
    }
    static string Text(Dictionary<string, object> value, string key) {
        var result = Field(value, key) as string; Require(result != null, "invalid_request"); return result;
    }
    static Dictionary<string, object> Obj(Dictionary<string, object> value, string key) { return Object(Field(value, key)); }
    static object[] ArrayField(Dictionary<string, object> value, string key) {
        var items = Field(value, key) as ArrayList;
        if (items != null) return items.ToArray();
        var array = Field(value, key) as object[]; Require(array != null, "invalid_request"); return array;
    }
    static void NonceName(string name, string prefix) { Require(Regex.IsMatch(name, "^" + prefix + "[a-f0-9]{32}$"), "invalid_name"); }
    static void JsonName(string name) {
        Require(Regex.IsMatch(name, "^[a-z][a-z0-9-]{0,63}\\.json$") && !Regex.IsMatch(name, "^(con|prn|aux|nul|com[1-9]|lpt[1-9])\\.json$"), "invalid_name");
    }
    static int AttachmentName(string name) {
        Require(Regex.IsMatch(name, "^[a-z][a-z0-9-]{0,63}\\.(png|jpg|jpeg|webp|gif|pdf)$") && !Regex.IsMatch(name, "^(con|prn|aux|nul|com[1-9]|lpt[1-9])\\."), "invalid_name");
        return name.EndsWith(".pdf", StringComparison.Ordinal) ? MaxAttachments : MaxImage;
    }
    static int FileLimit(string name) {
        if (name.EndsWith(".json", StringComparison.Ordinal)) { JsonName(name); return MaxJson; }
        return AttachmentName(name);
    }
    static string PrototypeRoot(string input) {
        Require(input.Length <= 512 && (input.Equals(Boundary, StringComparison.OrdinalIgnoreCase) || input.StartsWith(Boundary + "\\", StringComparison.OrdinalIgnoreCase)), "foreign_root");
        Require(input == Path.GetFullPath(input) && !input.EndsWith("\\"), "noncanonical_path");
        foreach (string part in input.Substring(3).Split('\\'))
            Require(Regex.IsMatch(part, "^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$"), "noncanonical_path");
        return input;
    }

    [StructLayout(LayoutKind.Sequential)] struct UnicodeString { internal ushort Length, MaximumLength; internal IntPtr Buffer; }
    [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { internal int Length; internal IntPtr RootDirectory, ObjectName; internal uint Attributes; internal IntPtr SecurityDescriptor, SecurityQualityOfService; }
    [StructLayout(LayoutKind.Sequential)] struct IoStatus { internal IntPtr Status, Information; }
    [StructLayout(LayoutKind.Sequential)] struct FileInfo {
        internal uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
        internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle handle, uint access, ref ObjectAttributes attributes, out IoStatus status, IntPtr size, uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaSize);
    [DllImport("ntdll.dll")] static extern int NtSetInformationFile(SafeFileHandle handle, out IoStatus status, IntPtr data, uint length, int informationClass);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
    [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(SafeFileHandle handle, int type, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(SafeFileHandle handle, byte[] buffer, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadFile(SafeFileHandle handle, byte[] buffer, uint count, out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool FlushFileBuffers(SafeFileHandle handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetFilePointerEx(SafeFileHandle handle, long distance, out long position, uint method);

    static SafeFileHandle Open(SafeFileHandle parent, string name, bool directory, bool create, bool writable, bool deletable, bool deleteOnClose = false) {
        IntPtr chars = IntPtr.Zero, unicode = IntPtr.Zero, security = IntPtr.Zero;
        try {
            chars = Marshal.StringToHGlobalUni(name);
            var text = new UnicodeString { Length = checked((ushort)(name.Length * 2)), MaximumLength = checked((ushort)(name.Length * 2 + 2)), Buffer = chars };
            unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString))); Marshal.StructureToPtr(text, unicode, false);
            if (create) {
                string flags = directory ? "OICI" : "";
                var descriptor = new RawSecurityDescriptor("O:" + UserSid + "D:P(A;" + flags + ";FA;;;" + UserSid + ")(A;" + flags + ";FA;;;SY)");
                var bytes = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(bytes, 0);
                security = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, security, bytes.Length);
            }
            var attributes = new ObjectAttributes {
                Length = Marshal.SizeOf(typeof(ObjectAttributes)), RootDirectory = parent == null ? IntPtr.Zero : parent.DangerousGetHandle(),
                ObjectName = unicode, Attributes = 0x40, SecurityDescriptor = security
            };
            // Each component is opened relative to a pinned parent, with no delete sharing.
            // FILE_OPEN_REPARSE_POINT inspects the entry itself instead of following it.
            uint access = BaseAccess | (directory ? 0x20u : 1u) | (writable ? 2u : 0u) | (deletable ? Delete : 0u);
            SafeFileHandle handle; IoStatus status;
            uint options = (directory ? DirectoryOptions : FileOptions) | (deleteOnClose ? 0x1000u : 0u);
            int result = NtCreateFile(out handle, access, ref attributes, out status, IntPtr.Zero, 0x80, directory ? 3u : 1u, create ? 2u : 1u, options, IntPtr.Zero, 0);
            if (result < 0) {
                if (handle != null) handle.Dispose();
                if (unchecked((uint)result) == 0xc0000035) throw new Refusal("already_exists");
                throw new Refusal("native_open_" + unchecked((uint)result).ToString("x8"));
            }
            return handle;
        } finally {
            if (security != IntPtr.Zero) Marshal.FreeHGlobal(security);
            if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode);
            if (chars != IntPtr.Zero) Marshal.FreeHGlobal(chars);
        }
    }

    static Dictionary<string, object> Inspect(SafeFileHandle handle, string expectedPath, bool directory, bool isPrivate, Dictionary<string, object> expected) {
        FileInfo file; Require(GetFileInformationByHandle(handle, out file), "handle_info_failed");
        Require((file.Attributes & 0x400) == 0, "reparse_point");
        Require(((file.Attributes & 0x10) != 0) == directory, "wrong_type");
        if (!directory) Require(file.Links == 1, "hard_link");
        var path = new StringBuilder(1024); uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
        Require(length > 0 && length < path.Capacity && path.ToString().Equals(@"\\?\" + expectedPath, StringComparison.OrdinalIgnoreCase), "path_escape");
        string id = file.Volume.ToString("x8") + ":" + file.IndexHigh.ToString("x8") + file.IndexLow.ToString("x8") + ":" + file.CreationHigh.ToString("x8") + file.CreationLow.ToString("x8");
        if (expected != null) Require(Text(expected, "id") == id && Text(expected, "path").Equals(expectedPath, StringComparison.OrdinalIgnoreCase), "identity_changed");
        IntPtr owner, group, dacl, sacl, security;
        Require(GetSecurityInfo(handle, 1, 1 | 4, out owner, out group, out dacl, out sacl, out security) == 0, "acl_read_failed");
        RawSecurityDescriptor descriptor;
        try {
            uint size = GetSecurityDescriptorLength(security); Require(size > 0 && size <= 65536, "acl_invalid");
            byte[] bytes = new byte[size]; Marshal.Copy(security, bytes, 0, bytes.Length); descriptor = new RawSecurityDescriptor(bytes, 0);
        } finally { LocalFree(security); }
        Require(descriptor.Owner != null, "owner_missing");
        string sid = descriptor.Owner.Value;
        bool protectedDacl = (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0;
        int inherited = 0;
        if (descriptor.DiscretionaryAcl != null) foreach (GenericAce ace in descriptor.DiscretionaryAcl) if ((ace.AceFlags & AceFlags.Inherited) != 0) inherited++;
        if (isPrivate) {
            Require(sid == UserSid, "foreign_owner");
            Require(protectedDacl && descriptor.DiscretionaryAcl != null && descriptor.DiscretionaryAcl.Count == 2 && inherited == 0, "private_acl_required");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            AceFlags flags = directory ? AceFlags.ContainerInherit | AceFlags.ObjectInherit : AceFlags.None;
            foreach (GenericAce raw in descriptor.DiscretionaryAcl) {
                var ace = raw as CommonAce;
                Require(ace != null && !ace.IsCallback && ace.AceQualifier == AceQualifier.AccessAllowed && ace.AccessMask == FullControl && ace.AceFlags == flags, "private_acl_required");
                Require((ace.SecurityIdentifier.Value == UserSid || ace.SecurityIdentifier.Value == "S-1-5-18") && seen.Add(ace.SecurityIdentifier.Value), "private_acl_required");
            }
        } else {
            Require(sid == UserSid || sid == "S-1-5-18" || sid == "S-1-5-32-544" || expectedPath == @"C:\", "foreign_ancestor_owner");
        }
        return new Dictionary<string, object> {
            { "path", expectedPath }, { "id", id }, { "ownerSid", sid }, { "protectedDacl", protectedDacl },
            { "aceCount", descriptor.DiscretionaryAcl == null ? 0 : descriptor.DiscretionaryAcl.Count }, { "inheritedAceCount", inherited },
            { "linkCount", file.Links }, { "kind", directory ? "directory" : "file" },
            { "byteLength", directory ? 0L : ((long)file.SizeHigh << 32) | file.SizeLow }
        };
    }

    sealed class Chain : IDisposable {
        internal readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
        internal readonly List<object> Ancestors = new List<object>();
        internal SafeFileHandle Last { get { return Handles[Handles.Count - 1]; } }
        internal string Root;
        internal Chain(string root, object[] expected) {
            Root = PrototypeRoot(root);
            try {
                Handles.Add(Open(null, @"\??\C:\", true, false, false, false));
                Inspect(Last, @"C:\", true, false, null);
                string current = @"C:\";
                string[] pieces = Root.Substring(3).Split('\\');
                Require(expected == null || expected.Length == pieces.Length, "identity_changed");
                for (int i = 0; i < pieces.Length; i++) {
                    current = Path.Combine(current, pieces[i]); Handles.Add(Open(Last, pieces[i], true, false, false, false));
                    Ancestors.Add(Inspect(Last, current, true, false, expected == null ? null : Object(expected[i])));
                }
            } catch { Dispose(); throw; }
        }
        public void Dispose() { for (int i = Handles.Count - 1; i >= 0; i--) Handles[i].Dispose(); Handles.Clear(); }
    }
    sealed class TaskRoot : IDisposable {
        internal Chain Chain;
        internal SafeFileHandle Handle;
        internal string Path;
        internal Dictionary<string, object> Receipt;
        internal TaskRoot(Dictionary<string, object> receipt, bool deletable) {
            Receipt = receipt;
            var info = Obj(receipt, "task"); Path = Text(info, "path");
            string root = PrototypeRoot(Text(receipt, "prototypeRoot"));
            string name = System.IO.Path.GetFileName(Path); NonceName(name, "private-task-");
            Require(Path.Equals(System.IO.Path.Combine(root, name), StringComparison.OrdinalIgnoreCase), "path_escape");
            try {
                Chain = new Chain(root, ArrayField(receipt, "ancestors"));
                Handle = Open(Chain.Last, name, true, false, false, deletable);
                Inspect(Handle, Path, true, true, info);
            } catch { Dispose(); throw; }
        }
        public void Dispose() { if (Handle != null) Handle.Dispose(); if (Chain != null) Chain.Dispose(); }
    }
    sealed class Launch : IDisposable {
        internal TaskRoot Task;
        internal SafeFileHandle Handle;
        internal string Path;
        internal Launch(Dictionary<string, object> receipt, bool deletable) {
            var info = Obj(receipt, "launch"); Path = Text(info, "path");
            try {
                Task = new TaskRoot(Obj(receipt, "task"), false);
                string name = System.IO.Path.GetFileName(Path); NonceName(name, "launch-");
                Require(Path.Equals(System.IO.Path.Combine(Task.Path, name), StringComparison.OrdinalIgnoreCase), "path_escape");
                Handle = Open(Task.Handle, name, true, false, false, deletable); Inspect(Handle, Path, true, true, info);
            } catch { Dispose(); throw; }
        }
        public void Dispose() { if (Handle != null) Handle.Dispose(); if (Task != null) Task.Dispose(); }
    }
    static void MarkDelete(SafeFileHandle handle) {
        IntPtr data = Marshal.AllocHGlobal(1);
        try { Marshal.WriteByte(data, 1); IoStatus status; Require(NtSetInformationFile(handle, out status, data, 1, 13) >= 0, "delete_failed"); }
        finally { Marshal.FreeHGlobal(data); }
    }
    static void Publish(SafeFileHandle handle, SafeFileHandle parent, string name, bool replace = false) {
        byte[] bytes = Encoding.Unicode.GetBytes(name); int offset = IntPtr.Size == 8 ? 20 : 12; int size = offset + bytes.Length + 2;
        IntPtr data = Marshal.AllocHGlobal(size);
        try {
            Marshal.Copy(new byte[size], 0, data, size);
            Marshal.WriteByte(data, replace ? (byte)1 : (byte)0);
            Marshal.WriteIntPtr(data, IntPtr.Size == 8 ? 8 : 4, parent.DangerousGetHandle());
            Marshal.WriteInt32(data, IntPtr.Size == 8 ? 16 : 8, bytes.Length); Marshal.Copy(bytes, 0, IntPtr.Add(data, offset), bytes.Length);
            IoStatus status; int result = NtSetInformationFile(handle, out status, data, (uint)size, 10);
            if (unchecked((uint)result) == 0xc0000035) throw new Refusal("already_exists");
            Require(result >= 0, "publish_failed");
        } finally { Marshal.FreeHGlobal(data); }
    }
    static string Hash(SafeFileHandle handle, int maximum) {
        long position; Require(SetFilePointerEx(handle, 0, out position, 0), "seek_failed");
        using (var sha = SHA256.Create()) {
            byte[] buffer = new byte[16384]; int total = 0;
            for (;;) {
                uint count; Require(ReadFile(handle, buffer, (uint)buffer.Length, out count, IntPtr.Zero), "read_failed");
                if (count == 0) break;
                total += (int)count; Require(total <= maximum, "content_too_large"); sha.TransformBlock(buffer, 0, (int)count, null, 0);
            }
            sha.TransformFinalBlock(new byte[0], 0, 0); return BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
        }
    }
    static Dictionary<string, object> WriteAtomic(SafeFileHandle parent, string directory, string name, byte[] bytes, int maximum, bool replace) {
        string staging = "pending-" + Guid.NewGuid().ToString("N") + ".tmp";
        using (var file = Open(parent, staging, false, true, true, true)) {
            try {
                // The creation ACL is read back before any payload byte is written.
                Inspect(file, Path.Combine(directory, staging), false, true, null);
                uint written; Require(WriteFile(file, bytes, (uint)bytes.Length, out written, IntPtr.Zero) && written == bytes.Length, "write_failed");
                Require(FlushFileBuffers(file), "flush_failed");
                string hash = Hash(file, maximum);
                using (var sha = SHA256.Create()) Require(hash == BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(), "hash_mismatch");
                Inspect(file, Path.Combine(directory, staging), false, true, null);
                Publish(file, parent, name, replace);
                var info = Inspect(file, Path.Combine(directory, name), false, true, null); info.Add("sha256", hash); return info;
            } catch { MarkDelete(file); throw; }
        }
    }
    static string ReadMetadata(SafeFileHandle file) {
        long position; Require(SetFilePointerEx(file, 0, out position, 0), "seek_failed");
        using (var output = new MemoryStream()) {
            byte[] buffer = new byte[16384];
            for (;;) {
                uint read; Require(ReadFile(file, buffer, (uint)buffer.Length, out read, IntPtr.Zero), "read_failed");
                if (read == 0) break;
                Require(output.Length + read <= MaxJson, "content_too_large"); output.Write(buffer, 0, (int)read);
            }
            return Utf8.GetString(output.ToArray());
        }
    }
    static string[] PresentFiles(Launch launch) {
        var result = new List<string>();
        foreach (string path in Directory.GetFileSystemEntries(launch.Path)) if (Path.GetFileName(path) != OperationLock) result.Add(path);
        return result.ToArray();
    }
    static void ValidateBudget(Launch launch, bool attachment, int incoming) {
        long total = 0; int attachments = 0, json = 0;
        string[] paths = PresentFiles(launch); Require(paths.Length <= 26, "too_many_files");
        foreach (string path in paths) {
            string name = Path.GetFileName(path); int maximum = FileLimit(name);
            using (var handle = Open(launch.Handle, name, false, false, false, false)) {
                var info = Inspect(handle, path, false, true, null); long size = Convert.ToInt64(info["byteLength"]);
                Require(size <= maximum, "content_too_large");
                if (name.EndsWith(".json", StringComparison.Ordinal)) json++;
                else { attachments++; total += size; }
            }
        }
        Require(json + (attachment ? 0 : 1) <= 16, "json_count_limit");
        Require(attachments + (attachment ? 1 : 0) <= 10, "attachment_count_limit");
        Require(total + (attachment ? incoming : 0) <= MaxAttachments, "attachment_total_limit");
    }
    static object Execute(Dictionary<string, object> request) {
        string command = Text(request, "command");
        if (command == "create-task" || command == "ensure-task") {
            string root = PrototypeRoot(Text(request, "prototypeRoot")), name;
            if (command == "ensure-task") {
                string key = Text(request, "key"); Require(Regex.IsMatch(key, "^[a-f0-9]{64}$"), "invalid_key");
                using (var sha = SHA256.Create()) name = "private-task-" + BitConverter.ToString(sha.ComputeHash(Utf8.GetBytes(UserSid + "\0" + key))).Replace("-", "").ToLowerInvariant().Substring(0, 32);
            } else { name = Text(request, "name"); NonceName(name, "private-task-"); }
            using (var chain = new Chain(root, null)) {
                SafeFileHandle task; bool created = true;
                try { task = Open(chain.Last, name, true, true, false, true); }
                catch (Refusal refusal) {
                    if (command != "ensure-task" || refusal.Code != "already_exists") throw;
                    created = false; task = Open(chain.Last, name, true, false, false, false);
                }
                using (task) {
                    try {
                        var info = Inspect(task, Path.Combine(root, name), true, true, null);
                        return new { prototypeRoot = root, ancestors = chain.Ancestors, task = info };
                    } catch { if (created) MarkDelete(task); throw; }
                }
            }
        }
        if (command == "read-state" || command == "write-state") {
            using (var task = new TaskRoot(Obj(request, "task"), false))
            using (var operation = Open(task.Handle, OperationLock, false, true, true, true, true)) {
                Inspect(operation, Path.Combine(task.Path, OperationLock), false, true, null);
                Dictionary<string, object> previous = command == "write-state" && Field(request, "previous") != null ? Obj(request, "previous") : null;
                bool found = false;
                try {
                    using (var file = Open(task.Handle, StateName, false, false, false, false)) {
                        found = true;
                        var info = Inspect(file, Path.Combine(task.Path, StateName), false, true, previous);
                        string hash = Hash(file, MaxJson); info.Add("sha256", hash);
                        if (command == "read-state") return new { file = info, content = ReadMetadata(file) };
                        Require(previous != null && hash == Text(previous, "sha256"), "state_conflict");
                    }
                } catch (Refusal refusal) {
                    if (refusal.Code != "native_open_c0000034") throw;
                    Require(previous == null, "state_conflict");
                }
                if (command == "read-state") {
                    foreach (string entry in Directory.GetFileSystemEntries(task.Path)) Require(Path.GetFileName(entry) == OperationLock, "state_missing_assets");
                    return null;
                }
                string content = Text(request, "content"); byte[] bytes = Utf8.GetBytes(content);
                Require(bytes.Length <= MaxJson, "content_too_large"); Json.DeserializeObject(content);
                return WriteAtomic(task.Handle, task.Path, StateName, bytes, MaxJson, found);
            }
        }
        if (command == "verify-task" || command == "remove-task" || command == "create-launch") {
            var receipt = Obj(request, "task");
            using (var task = new TaskRoot(receipt, command == "remove-task")) {
                if (command == "verify-task") return Inspect(task.Handle, task.Path, true, true, Obj(receipt, "task"));
                if (command == "remove-task") {
                    Require(Directory.GetFileSystemEntries(task.Path).Length == 0, "unexpected_children"); MarkDelete(task.Handle); return new { removed = 1 };
                }
                string name = Text(request, "name"); NonceName(name, "launch-");
                using (var launch = Open(task.Handle, name, true, true, false, true)) {
                    try { return new { task = receipt, launch = Inspect(launch, Path.Combine(task.Path, name), true, true, null) }; }
                    catch { MarkDelete(launch); throw; }
                }
            }
        }
        Require(command == "write-json" || command == "write-bytes" || command == "verify-launch" || command == "remove-launch", "unsupported_command");
        var launchReceipt = Obj(request, "launch");
        using (var launch = new Launch(launchReceipt, command == "remove-launch"))
        // A create-new, delete-on-close lock serializes helper operations across processes.
        // A crash closes the kernel handle and removes the lock; no watcher or stale-lock adoption.
        using (var operation = Open(launch.Handle, OperationLock, false, true, true, true, true)) {
            Inspect(operation, Path.Combine(launch.Path, OperationLock), false, true, null);
            if (command == "write-json" || command == "write-bytes") {
                string name = Text(request, "name"); int maximum; byte[] bytes;
                bool attachment = command == "write-bytes";
                if (attachment) {
                    maximum = AttachmentName(name);
                    string encoded = Text(request, "contentBase64");
                    Require(encoded.Length <= ((maximum + 2) / 3) * 4, "content_too_large");
                    bytes = Convert.FromBase64String(encoded);
                    Require(bytes.Length <= maximum, "content_too_large");
                    Require(Convert.ToBase64String(bytes) == encoded, "noncanonical_base64");
                } else {
                    JsonName(name); maximum = MaxJson;
                    string content = Text(request, "content"); bytes = Utf8.GetBytes(content);
                    Require(bytes.Length <= maximum, "content_too_large"); Json.DeserializeObject(content);
                }
                ValidateBudget(launch, attachment, bytes.Length);
                return WriteAtomic(launch.Handle, launch.Path, name, bytes, maximum, false);
            }
            object[] expectedFiles = ArrayField(request, "files"); Require(expectedFiles.Length <= 26, "too_many_files");
            var handles = new List<SafeFileHandle>(); var infos = new List<object>(); var expectedPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try {
                foreach (object value in expectedFiles) {
                    var expected = Object(value); string path = Text(expected, "path"), name = Path.GetFileName(path); int maximum = FileLimit(name);
                    Require(path.Equals(Path.Combine(launch.Path, name), StringComparison.OrdinalIgnoreCase) && expectedPaths.Add(path), "path_escape");
                    var file = Open(launch.Handle, name, false, false, false, command == "remove-launch"); handles.Add(file);
                    var info = Inspect(file, path, false, true, expected); string hash = Hash(file, maximum); Require(hash == Text(expected, "sha256"), "content_changed"); info.Add("sha256", hash); infos.Add(info);
                }
                string[] present = PresentFiles(launch);
                Require(present.Length == expectedPaths.Count, "unexpected_children");
                foreach (string path in present) Require(expectedPaths.Contains(path), "unexpected_children");
                if (command == "verify-launch") return new { launch = Inspect(launch.Handle, launch.Path, true, true, Obj(launchReceipt, "launch")), files = infos };
                foreach (var handle in handles) MarkDelete(handle);
                foreach (var handle in handles) handle.Dispose(); handles.Clear(); operation.Dispose(); MarkDelete(launch.Handle); return new { removed = expectedFiles.Length + 1 };
            } finally { foreach (var handle in handles) handle.Dispose(); }
        }
    }
    static int Main(string[] args) {
        try {
            Require(args.Length == 0, "arguments_forbidden");
            byte[] bytes;
            using (var input = Console.OpenStandardInput()) using (var buffer = new MemoryStream()) {
                byte[] part = new byte[16384]; int read;
                while ((read = input.Read(part, 0, part.Length)) > 0) { Require(buffer.Length + read <= MaxInput, "request_too_large"); buffer.Write(part, 0, read); }
                bytes = buffer.ToArray();
            }
            var request = Object(Json.DeserializeObject(Utf8.GetString(bytes)));
            object result = Execute(request);
            using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) writer.WriteLine(Json.Serialize(new { ok = true, result = result }));
            return 0;
        } catch (Exception error) {
            var refusal = error as Refusal;
            // Never echo exception messages, serialized payloads, paths from invalid requests, or stderr.
            using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))) writer.WriteLine(Json.Serialize(new { ok = false, code = refusal == null ? "invalid_request_or_io" : refusal.Code }));
            return 1;
        }
    }
}

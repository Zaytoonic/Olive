// Mic Manager helper: controls Windows microphone (capture) endpoints via Core Audio.
// Protocol: one request per stdin line "id<TAB>cmd<TAB>args...", one JSON reply per stdout line.
// Commands: list | get <endpointId> | setvol <endpointId> <0..1> | setmute <endpointId> <0|1>
// Also prints {"event":"mic-key"} when an ASUS laptop's dedicated mic key is pressed.
// Compiled to win-audio.exe by tools/build-helper.js. win-audio.ps1 compiles this same file at run time if the exe is missing.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;

namespace MicManager
{
    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey { public Guid fmtid; public int pid; }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int GetAt(int index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        [PreserveSig] int GetState(out int state);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out int count);
        [PreserveSig] int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
        [PreserveSig] int GetChannelCount(out uint count);
        [PreserveSig] int SetMasterVolumeLevel(float levelDB, ref Guid eventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid eventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float levelDB);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDB, ref Guid eventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid eventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDB);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid eventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    }

    // ASUS laptops report the dedicated mic key as firmware event 124. Other PCs simply don't have this event class.
    public static class AsusKeys
    {
        const uint MIC_KEY = 124;
        static ManagementEventWatcher watcher;

        public static void Start()
        {
            try
            {
                watcher = new ManagementEventWatcher(new ManagementScope(@"root\wmi"), new WqlEventQuery("SELECT * FROM AsusAtkWmiEvent"));
                watcher.EventArrived += (sender, e) =>
                {
                    if (Convert.ToUInt32(e.NewEvent["EventID"]) != MIC_KEY) return;
                    Console.Out.WriteLine("{\"event\":\"mic-key\"}");
                    Console.Out.Flush();
                };
                watcher.Start();
            }
            catch (Exception) { }
        }
    }

    public static class Audio
    {
        const int eCapture = 1, eConsole = 0, DEVICE_STATE_ACTIVE = 1, CLSCTX_ALL = 23, STGM_READ = 0, VT_LPWSTR = 31;
        static Guid IID_IAudioEndpointVolume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
        static Guid FriendlyNameFmt = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");

        [DllImport("ole32.dll")]
        static extern int PropVariantClear(ref PropVariant pv);

        static void Check(int hr, string what)
        {
            if (hr < 0) throw new Exception(what + " failed (0x" + hr.ToString("X8") + ")");
        }

        static IMMDeviceEnumerator Enumerator()
        {
            return (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
        }

        static IMMDevice Device(string id)
        {
            IMMDevice d;
            Check(Enumerator().GetDevice(id, out d), "GetDevice");
            return d;
        }

        static IAudioEndpointVolume Volume(IMMDevice dev)
        {
            Guid iid = IID_IAudioEndpointVolume;
            object o;
            Check(dev.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out o), "Activate");
            return (IAudioEndpointVolume)o;
        }

        static string Name(IMMDevice dev)
        {
            IPropertyStore store;
            if (dev.OpenPropertyStore(STGM_READ, out store) < 0 || store == null) return "";
            PropertyKey key = new PropertyKey();
            key.fmtid = FriendlyNameFmt;
            key.pid = 14;
            PropVariant v;
            if (store.GetValue(ref key, out v) < 0) return "";
            try { return (v.vt == VT_LPWSTR && v.p != IntPtr.Zero) ? Marshal.PtrToStringUni(v.p) : ""; }
            finally { PropVariantClear(ref v); }
        }

        static string Describe(IMMDevice dev, string defaultId)
        {
            string id;
            Check(dev.GetId(out id), "GetId");
            IAudioEndpointVolume vol = Volume(dev);
            float level;
            bool muted;
            Check(vol.GetMasterVolumeLevelScalar(out level), "GetMasterVolumeLevelScalar");
            Check(vol.GetMute(out muted), "GetMute");
            return "{\"id\":" + Str(id)
                + ",\"name\":" + Str(Name(dev))
                + ",\"volume\":" + level.ToString("0.####", CultureInfo.InvariantCulture)
                + ",\"muted\":" + (muted ? "true" : "false")
                + ",\"isDefault\":" + (defaultId != null && id == defaultId ? "true" : "false") + "}";
        }

        public static string List()
        {
            IMMDeviceEnumerator en = Enumerator();
            string defaultId = null;
            IMMDevice def;
            if (en.GetDefaultAudioEndpoint(eCapture, eConsole, out def) >= 0 && def != null)
            {
                string did;
                if (def.GetId(out did) >= 0) defaultId = did;
            }
            IMMDeviceCollection col;
            Check(en.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, out col), "EnumAudioEndpoints");
            int count;
            Check(col.GetCount(out count), "GetCount");
            List<string> parts = new List<string>();
            for (int i = 0; i < count; i++)
            {
                IMMDevice d;
                if (col.Item(i, out d) < 0 || d == null) continue;
                try { parts.Add(Describe(d, defaultId)); } catch (Exception) { }
            }
            return "[" + string.Join(",", parts.ToArray()) + "]";
        }

        public static string Get(string id)
        {
            return Describe(Device(id), null);
        }

        public static string SetVolume(string id, string level)
        {
            float v = float.Parse(level, CultureInfo.InvariantCulture);
            if (v < 0f) v = 0f;
            if (v > 1f) v = 1f;
            Guid ctx = Guid.Empty;
            Check(Volume(Device(id)).SetMasterVolumeLevelScalar(v, ref ctx), "SetMasterVolumeLevelScalar");
            return Get(id);
        }

        public static string SetMute(string id, string on)
        {
            Guid ctx = Guid.Empty;
            Check(Volume(Device(id)).SetMute(on == "1", ref ctx), "SetMute");
            return Get(id);
        }

        public static string Handle(string line)
        {
            int reqId = 0;
            try
            {
                string[] a = line.Split('\t');
                if (!int.TryParse(a[0], out reqId)) throw new Exception("bad request id");
                string cmd = a.Length > 1 ? a[1] : "";
                string result;
                if (cmd == "list") result = List();
                else if (cmd == "get" && a.Length == 3) result = Get(a[2]);
                else if (cmd == "setvol" && a.Length == 4) result = SetVolume(a[2], a[3]);
                else if (cmd == "setmute" && a.Length == 4) result = SetMute(a[2], a[3]);
                else throw new Exception("bad command: " + cmd);
                return "{\"id\":" + reqId + ",\"ok\":true,\"result\":" + result + "}";
            }
            catch (Exception e)
            {
                return "{\"id\":" + reqId + ",\"ok\":false,\"error\":" + Str(e.Message) + "}";
            }
        }

        // JSON string with everything outside printable ASCII escaped, so output encoding never matters.
        static string Str(string s)
        {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 32 || c > 126) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        // Serves requests until the app closes stdin. Exit explicitly: the key watcher's threads must not keep this alive.
        public static void Run()
        {
            AsusKeys.Start();
            Console.Out.WriteLine("{\"id\":0,\"ok\":true,\"result\":\"ready\"}");
            Console.Out.Flush();
            while (true)
            {
                string line = Console.In.ReadLine();
                if (line == null) break;
                line = line.TrimEnd('\r');
                if (line.Length == 0) continue;
                Console.Out.WriteLine(Handle(line));
                Console.Out.Flush();
            }
            Environment.Exit(0);
        }
    }

    public static class Program
    {
        [MTAThread]   // firmware events and Core Audio both work without a message loop
        public static void Main() { Audio.Run(); }
    }
}

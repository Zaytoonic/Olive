// Shared by the installer and the uninstaller. Built by tools/make-installer.js with the C# compiler in Windows.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using Microsoft.Win32;

namespace OliveSetup
{
    static class Common
    {
        // Set by --tag, only for the installer's own test: it keeps every shortcut and registry value apart from a real install.
        public static string Tag = "";
        public const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        public const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";

        public static string AppName { get { return "Olive" + Tag; } }
        public static string LoginEntry { get { return "electron.app." + AppName; } }
        public static string UninstallKey { get { return @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + AppName; } }
        public static string StartMenuShortcut { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), AppName + ".lnk"); } }
        public static string DesktopShortcut { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), AppName + ".lnk"); } }
        public static string SettingsFolder { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), AppName.ToLowerInvariant()); } }

        public static string Option(string[] args, string name)
        {
            for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
            return null;
        }
        public static bool Flag(string[] args, string name) { return Array.IndexOf(args, name) >= 0; }

        static string PathOf(Process p)
        {
            try { return p.MainModule.FileName; } catch (Exception) { return null; }
        }
        static bool IsInside(string file, string dir)
        {
            return file != null && file.StartsWith(dir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
        }

        // Olive's folder can't be replaced while it's running. Closing the window only hides it to the tray, so it has to be ended.
        // Everywhere: any copy, because two copies share one set of settings and would mix on the cable. A test only touches its own folder.
        static List<Process> Running(string dir, bool everywhere)
        {
            List<Process> found = new List<Process>();
            foreach (string name in new[] { "Olive", "MicManager", "win-audio" })
            {
                foreach (Process p in Process.GetProcessesByName(name))
                {
                    if (IsInside(PathOf(p), dir) || (everywhere && name != "win-audio")) found.Add(p);
                }
            }
            return found;
        }
        public static bool AnyRunning(string dir, bool everywhere) { return Running(dir, everywhere).Count > 0; }
        public static void CloseRunning(string dir, bool everywhere)
        {
            foreach (Process p in Running(dir, everywhere))
            {
                try { p.Kill(); p.WaitForExit(5000); } catch (Exception) { }
            }
        }

        // Windows can keep a folder locked for a moment after the programs in it end, and an antivirus scan of
        // freshly unpacked files can hold it for several seconds more. Up to 30 s.
        public static void Retry(Action action)
        {
            for (int i = 0; ; i++)
            {
                try { action(); return; }
                catch (Exception)
                {
                    if (i >= 120) throw;
                    Thread.Sleep(250);
                }
            }
        }
    }
}

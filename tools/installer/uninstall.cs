// Removes Olive. Options: --silent, --tag <test name>, --remove-settings
// A running program can't delete its own folder, so this copies itself to the temp folder and finishes the job from there (--from-temp <folder>).
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OliveSetup
{
    static class Program
    {
        static void DeleteValue(string key, string name)
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(key, true))
            {
                if (k != null) k.DeleteValue(name, false);
            }
        }

        // Only if it points at this copy: Start with Windows might belong to another one.
        static void RemoveLoginEntry(string dir)
        {
            string value = null;
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(Common.RunKey))
            {
                if (k != null) value = k.GetValue(Common.LoginEntry) as string;
            }
            if (value == null || value.IndexOf(dir.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase) < 0) return;
            DeleteValue(Common.RunKey, Common.LoginEntry);
            DeleteValue(Common.ApprovedKey, Common.LoginEntry);
        }

        static void DeleteFile(string path)
        {
            if (File.Exists(path)) File.Delete(path);
        }

        static int FinishFromTemp(string dir, bool removeSettings, bool silent)
        {
            string error = null;
            try { Common.Retry(() => { if (Directory.Exists(dir)) Directory.Delete(dir, true); }); }
            catch (Exception ex) { error = ex.Message; }
            if (removeSettings)
            {
                try { Common.Retry(() => { if (Directory.Exists(Common.SettingsFolder)) Directory.Delete(Common.SettingsFolder, true); }); }
                catch (Exception ex) { error = error ?? ex.Message; }
            }
            if (!silent)
            {
                if (error != null) MessageBox.Show("Olive was removed, but some files couldn't be deleted. You can delete this folder yourself:\r\n" + dir + "\r\n\r\n" + error, "Uninstall Olive", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                else MessageBox.Show("Olive has been removed.", "Uninstall Olive");
            }
            // This copy in the temp folder removes itself a few seconds after it exits.
            Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 4 127.0.0.1 >nul & del /q \"" + Application.ExecutablePath + "\"") { CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden });
            return error == null ? 0 : 1;
        }

        [STAThread]
        static int Main(string[] args)
        {
            Common.Tag = Common.Option(args, "--tag") ?? "";
            bool silent = Common.Flag(args, "--silent"), removeSettings = Common.Flag(args, "--remove-settings");
            string fromTemp = Common.Option(args, "--from-temp");
            if (fromTemp != null) return FinishFromTemp(fromTemp, removeSettings, silent);

            string dir = Path.GetDirectoryName(Application.ExecutablePath);
            if (!silent)
            {
                if (MessageBox.Show("Remove Olive from this PC?", "Uninstall Olive", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) != DialogResult.Yes) return 0;
                removeSettings = MessageBox.Show("Also delete your settings and EQ?\r\n\r\nKeep them if you might install Olive again.", "Uninstall Olive", MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
            }
            Common.CloseRunning(dir, false);
            RemoveLoginEntry(dir);
            DeleteFile(Common.StartMenuShortcut);
            DeleteFile(Common.DesktopShortcut);
            Registry.CurrentUser.DeleteSubKeyTree(Common.UninstallKey, false);

            string copy = Path.Combine(Path.GetTempPath(), "Olive-uninstall-" + Guid.NewGuid().ToString("N") + ".exe");
            File.Copy(Application.ExecutablePath, copy);
            string next = "--from-temp \"" + dir + "\"" + (silent ? " --silent" : "") + (removeSettings ? " --remove-settings" : "") + (Common.Tag.Length > 0 ? " --tag " + Common.Tag : "");
            Process.Start(new ProcessStartInfo(copy, next) { UseShellExecute = false, WorkingDirectory = Path.GetTempPath() });
            return 0;
        }
    }
}

// The Olive installer: installs for this Windows account, so it needs no admin rights.
// The app and the uninstaller are embedded in this exe. Options: --silent, --dir <folder>, --tag <test name>, --log <file>
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

namespace OliveSetup
{
    static class Installer
    {
        const string PREFIX = "Olive/";
        const string APP_EXE = "Olive.exe", UNINSTALLER = "Uninstall Olive.exe";

        public static string DefaultFolder()
        {
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Olive");
        }

        static void Extract(string target, Action<int> progress)
        {
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (ZipArchive zip = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                string root = Path.GetFullPath(target).TrimEnd('\\') + "\\";
                int done = 0, total = zip.Entries.Count;
                foreach (ZipArchiveEntry entry in zip.Entries)
                {
                    done++;
                    string name = entry.FullName.Replace('\\', '/');
                    if (name.StartsWith(PREFIX)) name = name.Substring(PREFIX.Length);
                    if (name.Length == 0 || name.EndsWith("/")) continue;
                    string file = Path.GetFullPath(Path.Combine(root, name.Replace('/', '\\')));
                    if (!file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("Bad file in the installer: " + name);
                    Directory.CreateDirectory(Path.GetDirectoryName(file));
                    entry.ExtractToFile(file, true);
                    progress(done * 90 / total);
                }
            }
            using (Stream uninstaller = Assembly.GetExecutingAssembly().GetManifestResourceStream("uninstall.exe"))
            using (FileStream output = File.Create(Path.Combine(target, UNINSTALLER)))
            {
                uninstaller.CopyTo(output);
            }
        }

        // The new copy is complete before the old one moves, and the old one comes back if anything fails.
        static void Swap(string dir, string fresh, string old)
        {
            bool moved = false;
            try
            {
                if (Directory.Exists(dir)) { Common.Retry(() => Directory.Move(dir, old)); moved = true; }
                Common.Retry(() => Directory.Move(fresh, dir));
            }
            catch (Exception)
            {
                if (moved && !Directory.Exists(dir)) Directory.Move(old, dir);
                throw;
            }
            if (moved) { try { Directory.Delete(old, true); } catch (Exception) { /* a stale copy is harmless, and the next install clears it */ } }
        }

        static void CreateShortcut(string where, string exe, string description)
        {
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(shellType);
            object link = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { where });
            Type t = link.GetType();
            t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, link, new object[] { exe });
            t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, link, new object[] { Path.GetDirectoryName(exe) });
            t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, link, new object[] { exe + ",0" });
            t.InvokeMember("Description", BindingFlags.SetProperty, null, link, new object[] { description });
            t.InvokeMember("Save", BindingFlags.InvokeMethod, null, link, null);
        }

        static long FolderSizeKb(string dir)
        {
            long bytes = 0;
            foreach (string f in Directory.GetFiles(dir, "*", SearchOption.AllDirectories)) bytes += new FileInfo(f).Length;
            return bytes / 1024;
        }

        static void Register(string dir, bool desktop)
        {
            string exe = Path.Combine(dir, APP_EXE);
            string tagArg = Common.Tag.Length > 0 ? " --tag " + Common.Tag : "";
            string uninstall = "\"" + Path.Combine(dir, UNINSTALLER) + "\"" + tagArg;
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(Common.UninstallKey))
            {
                k.SetValue("DisplayName", Common.AppName);
                k.SetValue("DisplayVersion", Build.Version);
                k.SetValue("Publisher", "Zaytoon");
                k.SetValue("DisplayIcon", exe);
                k.SetValue("InstallLocation", dir);
                k.SetValue("UninstallString", uninstall);
                k.SetValue("QuietUninstallString", uninstall + " --silent");
                k.SetValue("EstimatedSize", (int)FolderSizeKb(dir), RegistryValueKind.DWord);
                k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
            CreateShortcut(Common.StartMenuShortcut, exe, "Olive microphone manager");
            if (desktop) CreateShortcut(Common.DesktopShortcut, exe, "Olive microphone manager");
            // Start with Windows stays as you set it, but must point at this copy from now on.
            using (RegistryKey run = Registry.CurrentUser.OpenSubKey(Common.RunKey, true))
            {
                if (run != null && run.GetValue(Common.LoginEntry) != null) run.SetValue(Common.LoginEntry, "\"" + exe + "\" --hidden");
            }
        }

        public static void Install(string dir, bool desktop, Action<int> progress)
        {
            dir = Path.GetFullPath(dir).TrimEnd('\\');
            string fresh = dir + ".new", old = dir + ".old";
            Common.CloseRunning(dir, Common.Tag.Length == 0);
            foreach (string stale in new[] { fresh, old })
            {
                if (Directory.Exists(stale)) Common.Retry(() => Directory.Delete(stale, true));
            }
            Directory.CreateDirectory(fresh);
            try
            {
                Extract(fresh, progress);
                Swap(dir, fresh, old);
            }
            catch (Exception)
            {
                try { Directory.Delete(fresh, true); } catch (Exception) { /* the next install clears it */ }
                throw;
            }
            progress(95);
            Register(dir, desktop);
            progress(100);
        }
    }

    class SetupForm : Form
    {
        static readonly Color Surface = Color.FromArgb(0x1d, 0x1c, 0x1a), Tile = Color.FromArgb(0x2b, 0x2a, 0x27);
        static readonly Color OliveColor = Color.FromArgb(0x6b, 0x7f, 0x3a), TextColor = Color.FromArgb(0xf5, 0xf4, 0xf0), Soft = Color.FromArgb(0x9c, 0x9a, 0x91);
        readonly string dir;
        readonly Label title = new Label(), detail = new Label();
        readonly CheckBox desktop = new CheckBox();
        readonly ProgressBar bar = new ProgressBar();
        readonly Button primary = new Button(), secondary = new Button();
        bool finished;

        Button Style(Button b, string text, Color back, int x)
        {
            b.Text = text; b.FlatStyle = FlatStyle.Flat; b.FlatAppearance.BorderSize = 0; b.BackColor = back; b.ForeColor = Color.White;
            b.Font = new Font("Segoe UI", 10f, FontStyle.Bold); b.SetBounds(x, 172, 130, 36);
            Controls.Add(b);
            return b;
        }

        public SetupForm(string dir)
        {
            this.dir = dir;
            Text = "Install Olive"; BackColor = Surface; ForeColor = TextColor;
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(500, 226); Font = new Font("Segoe UI", 10f);
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (Exception) { /* the default icon will do */ }

            title.Text = "Olive " + Build.Version; title.Font = new Font("Segoe UI", 18f, FontStyle.Bold); title.SetBounds(24, 18, 450, 40);
            detail.Text = "Installs for your Windows account, with no admin rights needed.\r\n" + dir;
            detail.ForeColor = Soft; detail.AutoEllipsis = true; detail.SetBounds(24, 62, 452, 44);
            desktop.Text = "Add a desktop shortcut"; desktop.ForeColor = TextColor; desktop.SetBounds(24, 114, 300, 26);
            bar.SetBounds(24, 144, 452, 8); bar.Visible = false;
            Controls.AddRange(new Control[] { title, detail, desktop, bar });
            Style(primary, "Install", OliveColor, 346).Click += (s, e) => { if (finished) OpenOlive(); else Start(); };
            Style(secondary, "Cancel", Tile, 206).Click += (s, e) => Close();
        }

        void Start()
        {
            if (Common.AnyRunning(dir, Common.Tag.Length == 0))
            {
                DialogResult go = MessageBox.Show(this, "Olive is running and needs to close to install. Your mic will stop reaching Discord until it starts again.", "Install Olive", MessageBoxButtons.OKCancel, MessageBoxIcon.Information);
                if (go != DialogResult.OK) return;
            }
            bool wantDesktop = desktop.Checked;
            primary.Enabled = false; secondary.Enabled = false; desktop.Enabled = false; bar.Visible = true;
            detail.Text = "Installing…";
            Thread worker = new Thread(() =>
            {
                string error = null;
                try { Installer.Install(dir, wantDesktop, p => BeginInvoke((Action)(() => bar.Value = p))); }
                catch (Exception ex) { error = ex.Message; }
                BeginInvoke((Action)(() => Finish(error)));
            });
            worker.IsBackground = true;
            worker.Start();
        }

        void Finish(string error)
        {
            secondary.Enabled = true;
            bar.Visible = false;
            if (error != null)
            {
                detail.Text = "Olive couldn't be installed, and nothing was changed:\r\n" + error;
                detail.ForeColor = Color.FromArgb(0xff, 0x69, 0x61);
                secondary.Text = "Close";
                return;
            }
            finished = true;
            detail.Text = "Olive is installed. You'll find it in the Start menu.";
            desktop.Visible = false;
            primary.Enabled = true; primary.Text = "Open Olive";
            secondary.Text = "Close";
        }

        void OpenOlive()
        {
            try { Process.Start(new ProcessStartInfo(Path.Combine(dir, "Olive.exe")) { UseShellExecute = true, WorkingDirectory = dir }); }
            catch (Exception ex) { MessageBox.Show(this, "Couldn't open Olive: " + ex.Message, "Install Olive"); }
            Close();
        }
    }

    static class Program
    {
        [STAThread]
        static int Main(string[] args)
        {
            Common.Tag = Common.Option(args, "--tag") ?? "";
            string dir = Common.Option(args, "--dir") ?? Installer.DefaultFolder();
            if (Common.Flag(args, "--silent"))
            {
                string log = Common.Option(args, "--log");
                try
                {
                    Installer.Install(dir, Common.Flag(args, "--desktop"), p => { });
                    return 0;
                }
                catch (Exception ex)
                {
                    if (log != null) File.WriteAllText(log, ex.ToString());
                    return 1;
                }
            }
            Application.EnableVisualStyles();
            Application.Run(new SetupForm(Path.GetFullPath(dir)));
            return 0;
        }
    }
}

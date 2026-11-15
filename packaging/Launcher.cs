using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        int port = 8080;
        bool noWindow = false, quiet = false, quit = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--port" && i + 1 < args.Length) int.TryParse(args[++i], out port);
            else if (args[i] == "--no-window") noWindow = true;
            else if (args[i] == "--self-test") quiet = true;
            else if (args[i] == "--quit") quit = true;
        }
        if (port < 1 || port > 65535) return 2;
        string name = "Local\\MobileTV." + port;
        if (quit) return Signal(name + ".Exit") ? 0 : 1;
        bool first;
        using (Mutex mutex = new Mutex(true, name, out first))
        {
            if (!first)
            {
                if (noWindow) return 0;
                // Reopening a newer launcher must use its player selection even
                // when an older tray process still owns the receiving service.
                try { if (ReceiverContext.IsReceiverReady(port)) { ReceiverContext.OpenPlayerWindow(port); return 0; } }
                catch { /* Ask the existing tray to reopen if direct launch fails. */ }
                for (int i = 0; i < 20; i++)
                {
                    if (Signal(name + ".Open")) return 0;
                    Thread.Sleep(100);
                }
                return 1;
            }
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (ReceiverContext context = new ReceiverContext(port, name, noWindow, quiet))
                    Application.Run(context);
                return Environment.ExitCode;
            }
            catch (Exception ex)
            {
                if (!quiet) MessageBox.Show("MobileTV 启动失败：\n" + ex.Message, "MobileTV", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    private static bool Signal(string name)
    {
        try { using (EventWaitHandle handle = EventWaitHandle.OpenExisting(name)) return handle.Set(); }
        catch (WaitHandleCannotBeOpenedException) { return false; }
    }
}

internal sealed class ReceiverContext : ApplicationContext
{
    private readonly EventWaitHandle openEvent, exitEvent;
    private readonly NotifyIcon tray;
    private readonly System.Windows.Forms.Timer timer;
    private readonly bool quiet;
    private readonly string url, dataDir;
    private readonly DateTime deadline = DateTime.UtcNow.AddSeconds(30);
    private readonly object logLock = new object();
    private StreamWriter log;
    private Process backend;
    private IntPtr job;
    private bool ready, openRequested, stopping;

    public ReceiverContext(int port, string name, bool noWindow, bool quietMode)
    {
        quiet = quietMode;
        url = "http://127.0.0.1:" + port + "/";
        string root = AppDomain.CurrentDomain.BaseDirectory;
        dataDir = Environment.GetEnvironmentVariable("MOBILETV_DATA_DIR");
        if (String.IsNullOrWhiteSpace(dataDir)) dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MobileTV", "data");
        dataDir = Path.GetFullPath(dataDir);
        string logs = Path.Combine(dataDir, "logs");
        Directory.CreateDirectory(logs);
        string logPath = Path.Combine(logs, "receiver-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-" + Process.GetCurrentProcess().Id + ".log");
        log = new StreamWriter(logPath, false, new System.Text.UTF8Encoding(false)) { AutoFlush = true };
        openEvent = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Open");
        exitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Exit");
        openRequested = !noWindow;
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("打开接收界面", null, delegate { openRequested = true; });
        menu.Items.Add("查看运行日志", null, delegate { Process.Start("explorer.exe", Quote(logs)); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出 MobileTV", null, delegate { ExitThread(); });
        tray = new NotifyIcon { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath), Text = "MobileTV · 正在启动", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { openRequested = true; };
        timer = new System.Windows.Forms.Timer { Interval = 500 };
        timer.Tick += Tick;
        try
        {
            if (IsReady()) { ready = true; WriteLog("Using existing receiver at " + url); }
            else
            {
                string node = Path.Combine(root, "runtime", "node.exe");
                string server = Path.Combine(root, "app", "src", "server.js");
                if (!File.Exists(node) || !File.Exists(server)) throw new FileNotFoundException("程序文件不完整，请完整解压发布包后重试。");
                ProcessStartInfo start = new ProcessStartInfo(node, Quote(server));
                start.WorkingDirectory = Path.Combine(root, "app");
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.RedirectStandardOutput = true;
                start.RedirectStandardError = true;
                start.StandardOutputEncoding = System.Text.Encoding.UTF8;
                start.StandardErrorEncoding = System.Text.Encoding.UTF8;
                start.EnvironmentVariables["MOBILETV_DATA_DIR"] = dataDir;
                start.EnvironmentVariables["PORT"] = port.ToString();
                start.EnvironmentVariables["NO_OPEN"] = "1";
                start.EnvironmentVariables["PATH"] = Path.Combine(root, "tools") + ";" + Environment.GetEnvironmentVariable("PATH");
                backend = new Process { StartInfo = start };
                backend.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) WriteLog(e.Data); };
                backend.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) WriteLog(e.Data); };
                backend.Start();
                AttachJob(backend);
                backend.BeginOutputReadLine();
                backend.BeginErrorReadLine();
                WriteLog("Started receiver PID " + backend.Id + "; data: " + dataDir);
            }
            timer.Start();
        }
        catch
        {
            Cleanup();
            throw;
        }
    }

    private void Tick(object sender, EventArgs e)
    {
        if (exitEvent.WaitOne(0)) { ExitThread(); return; }
        if (openEvent.WaitOne(0)) openRequested = true;
        if (backend != null && backend.HasExited) { Fail("后台服务已退出。请在运行日志中查看原因。退出代码：" + backend.ExitCode); return; }
        if (!ready)
        {
            ready = IsReady();
            if (!ready && DateTime.UtcNow > deadline) { Fail("启动超时。请检查 8080 端口是否被占用，并查看运行日志。"); return; }
        }
        if (ready)
        {
            tray.Text = "MobileTV · 正在接收投屏";
            if (openRequested)
            {
                openRequested = false;
                try { OpenWindow(); }
                catch (Exception ex) { WriteLog(ex.ToString()); if (!quiet) MessageBox.Show("接收服务已启动。请在浏览器打开：\n" + url, "MobileTV"); }
            }
        }
    }

    private bool IsReady()
    {
        return IsReceiverReady(new Uri(url).Port);
    }

    internal static bool IsReceiverReady(int port)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/api/status");
            request.Proxy = null;
            request.Timeout = 400;
            request.ReadWriteTimeout = 400;
            using (WebResponse response = request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                var status = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(reader.ReadToEnd());
                return status.ContainsKey("identity") && status.ContainsKey("state") && status.ContainsKey("tvUrl");
            }
        }
        catch { return false; }
    }

    private void OpenWindow()
    {
        WriteLog("Opening player window");
        OpenPlayerWindow(new Uri(url).Port);
    }

    internal static void OpenPlayerWindow(int port)
    {
        string url = "http://127.0.0.1:" + port + "/";
        string dataDir = Environment.GetEnvironmentVariable("MOBILETV_DATA_DIR");
        if (String.IsNullOrWhiteSpace(dataDir)) dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MobileTV", "data");
        dataDir = Path.GetFullPath(dataDir);
        string chrome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe");
        string chromeX86 = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe");
        string chromeUser = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe");
        string edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe");
        string edge64 = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe");
        bool preferEdge = String.Equals(Environment.GetEnvironmentVariable("MOBILETV_PLAYER_BROWSER"), "edge", StringComparison.OrdinalIgnoreCase);
        // Chrome's D3D11 HEVC path avoids the frame loss observed with Edge's
        // platform decoder. Use an installed browser, with Edge as fallback.
        string[] candidates = preferEdge ? new[] { edge, edge64, chrome, chromeX86, chromeUser } : new[] { chrome, chromeX86, chromeUser, edge, edge64 };
        foreach (string browser in candidates)
        {
            if (!File.Exists(browser)) continue;
            bool isChrome = String.Equals(Path.GetFileName(browser), "chrome.exe", StringComparison.OrdinalIgnoreCase);
            string profile = Path.Combine(dataDir, isChrome ? "browser-chrome" : "browser");
            Process.Start(new ProcessStartInfo(browser, "--app=" + url + " --window-size=1280,820 --autoplay-policy=no-user-gesture-required --no-first-run --no-default-browser-check --user-data-dir=" + Quote(profile)) { UseShellExecute = false });
            return;
        }
        Process.Start(url);
    }

    private void Fail(string message)
    {
        WriteLog(message);
        Environment.ExitCode = 1;
        if (!quiet) MessageBox.Show(message + "\n\n日志目录：" + Path.Combine(dataDir, "logs"), "MobileTV", MessageBoxButtons.OK, MessageBoxIcon.Error);
        ExitThread();
    }

    private void WriteLog(string message)
    {
        lock (logLock) { try { if (log != null) log.WriteLine(DateTime.Now.ToString("O") + " " + message); } catch (ObjectDisposedException) { } }
    }

    protected override void ExitThreadCore() { Cleanup(); base.ExitThreadCore(); }
    protected override void Dispose(bool disposing) { if (disposing) Cleanup(); base.Dispose(disposing); }
    private void Cleanup()
    {
        if (stopping) return;
        stopping = true;
        if (timer != null) { timer.Stop(); timer.Dispose(); }
        if (job != IntPtr.Zero) { CloseHandle(job); job = IntPtr.Zero; }
        if (backend != null)
        {
            try { if (!backend.HasExited) backend.Kill(); backend.WaitForExit(3000); } catch (InvalidOperationException) { }
            backend.Dispose();
        }
        if (tray != null) { tray.Visible = false; tray.ContextMenuStrip.Dispose(); tray.Icon.Dispose(); tray.Dispose(); }
        if (openEvent != null) openEvent.Dispose();
        if (exitEvent != null) exitEvent.Dispose();
        lock (logLock) { if (log != null) { log.Dispose(); log = null; } }
    }

    private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    private void AttachJob(Process process)
    {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        JobInfo info = new JobInfo();
        info.Basic.LimitFlags = 0x2000; // Terminate owned Node and FFmpeg children when the launcher exits.
        int size = Marshal.SizeOf(info);
        IntPtr memory = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, memory, false);
            if (!SetInformationJobObject(job, 9, memory, (uint)size) || !AssignProcessToJobObject(job, process.Handle))
                throw new System.ComponentModel.Win32Exception();
        }
        finally { Marshal.FreeHGlobal(memory); }
    }

    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public long ProcessTime, JobTime; public uint LimitFlags; public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] private struct JobInfo { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}

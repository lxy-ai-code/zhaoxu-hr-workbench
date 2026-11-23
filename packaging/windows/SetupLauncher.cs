using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Windows.Forms;

internal static class SetupLauncher
{
    private const string PayloadName = "ZhaoxuHR.SetupPayload";

    [STAThread]
    private static int Main(string[] args)
    {
        bool verify = args.Length == 1 && args[0] == "--verify-payload";
        string temporaryParent = Path.GetFullPath(Path.GetTempPath()).TrimEnd(Path.DirectorySeparatorChar);
        string staging = Path.Combine(temporaryParent, "ZhaoxuHR-Setup-" + Guid.NewGuid().ToString("N"));
        try
        {
            if (!Environment.Is64BitOperatingSystem || Environment.OSVersion.Platform != PlatformID.Win32NT)
                throw new InvalidOperationException("This installer requires 64-bit Windows.");

            Directory.CreateDirectory(staging);
            using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadName))
            {
                if (payload == null) throw new InvalidDataException("The installation package is incomplete.");
                string payloadPath = Path.Combine(staging, "package.zip");
                using (Stream destination = File.Create(payloadPath)) payload.CopyTo(destination);
                ZipFile.ExtractToDirectory(payloadPath, staging);
            }

            string script = Path.Combine(staging, "Install.ps1");
            if (!File.Exists(script) || !File.Exists(Path.Combine(staging, "app", "vendor", "node", "node.exe")))
                throw new InvalidDataException("The installation package is incomplete.");
            if (verify) return 0;

            string powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
            var processInfo = new ProcessStartInfo(powershell, "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"");
            processInfo.WorkingDirectory = staging;
            processInfo.UseShellExecute = false;
            using (Process installer = Process.Start(processInfo))
            {
                if (installer == null) throw new InvalidOperationException("The installation script could not be started.");
                installer.WaitForExit();
                return installer.ExitCode;
            }
        }
        catch (Exception error)
        {
            if (!verify) MessageBox.Show(error.Message, "招序 HR 安装", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally
        {
            string resolved = Path.GetFullPath(staging);
            if (String.Equals(Path.GetDirectoryName(resolved), temporaryParent, StringComparison.OrdinalIgnoreCase) &&
                Path.GetFileName(resolved).StartsWith("ZhaoxuHR-Setup-", StringComparison.Ordinal) &&
                Directory.Exists(resolved) && (File.GetAttributes(resolved) & FileAttributes.ReparsePoint) == 0)
            {
                try { Directory.Delete(resolved, true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }
}

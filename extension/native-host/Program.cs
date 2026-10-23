using System.Diagnostics;
using System.Text.Json;

internal sealed record HostConfig(string ServerPath, string ModelPath, string DataDirectory);
internal sealed record RunningServer(int ProcessId, string ServerPath, bool StartedBySubVid);

internal static class Program
{
    private const string BaseUrl = "http://127.0.0.1:8080";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static string ConfigPath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "SubVid", "hymt2-host.json");

    private static async Task<int> Main()
    {
        try
        {
            using var input = Console.OpenStandardInput();
            var header = new byte[4];
            await ReadExactly(input, header);
            var length = BitConverter.ToInt32(header);
            if (length is <= 0 or > 1024 * 1024) throw new InvalidDataException("Mensaje Native Messaging inválido.");
            var body = new byte[length];
            await ReadExactly(input, body);
            using var request = JsonDocument.Parse(body);
            var command = request.RootElement.TryGetProperty("command", out var value) ? value.GetString() : null;
            object response = command switch
            {
                "start" => await StartAsync(),
                "stop" => await StopAsync(),
                _ => new { ok = false, error = "Comando Native Messaging desconocido." },
            };
            await WriteResponse(response);
            return 0;
        }
        catch (Exception ex)
        {
            await WriteResponse(new { ok = false, error = ex.Message });
            return 1;
        }
    }

    private static async Task<object> StartAsync()
    {
        var config = LoadConfig();
        Directory.CreateDirectory(config.DataDirectory);
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        if (await IsServerReady(http))
            return new { ok = true, alreadyRunning = true, startedBySubVid = await IsManagedServerRunning(config) };

        var info = new FileInfo(config.ServerPath);
        if (!info.Exists) throw new FileNotFoundException("No se encontró llama-server.exe configurado.", config.ServerPath);
        if (!File.Exists(config.ModelPath)) throw new FileNotFoundException("No se encontró el GGUF Hy-MT2 configurado.", config.ModelPath);
        var statePath = Path.Combine(config.DataDirectory, "hymt2-server.json");
        var stdoutPath = Path.Combine(config.DataDirectory, "llama-server.stdout.log");
        var stderrPath = Path.Combine(config.DataDirectory, "llama-server.stderr.log");
        var pidPath = Path.Combine(config.DataDirectory, $"llama-server-{Guid.NewGuid():N}.pid");
        var launcherErrorPath = Path.Combine(config.DataDirectory, $"llama-server-{Guid.NewGuid():N}.error");
        await File.WriteAllTextAsync(stdoutPath, "");
        await File.WriteAllTextAsync(stderrPath, "");
        var args = new[] { "-m", config.ModelPath, "--host", "127.0.0.1", "--port", "8080", "--jinja", "-c", "4096", "-ngl", "33" };
        var serverArguments = string.Join(" ", args.Select(WindowsArgQuote));
        var ps = "$ErrorActionPreference = 'Stop'; try { $p = Start-Process -FilePath " + PsQuote(info.FullName)
            + " -ArgumentList " + PsQuote(serverArguments)
            + " -WorkingDirectory " + PsQuote(info.DirectoryName!)
            + " -WindowStyle Hidden -PassThru -RedirectStandardOutput " + PsQuote(stdoutPath)
            + " -RedirectStandardError " + PsQuote(stderrPath)
            + "; [IO.File]::WriteAllText(" + PsQuote(pidPath) + ", [string]$p.Id) } catch { [IO.File]::WriteAllText(" + PsQuote(launcherErrorPath) + ", $_.ToString()); exit 1 }";
        var launcher = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        launcher.ArgumentList.Add("-NoProfile");
        launcher.ArgumentList.Add("-NonInteractive");
        launcher.ArgumentList.Add("-EncodedCommand");
        launcher.ArgumentList.Add(Convert.ToBase64String(System.Text.Encoding.Unicode.GetBytes(ps)));
        using var launchProcess = Process.Start(launcher) ?? throw new InvalidOperationException("Windows no pudo iniciar el host de llama-server.");
        await launchProcess.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(20));
        var pidText = File.Exists(pidPath) ? await File.ReadAllTextAsync(pidPath) : "";
        var launchError = File.Exists(launcherErrorPath) ? await File.ReadAllTextAsync(launcherErrorPath) : "";
        DeleteState(pidPath);
        DeleteState(launcherErrorPath);
        if (launchProcess.ExitCode != 0 || !int.TryParse(pidText.Trim(), out var serverPid))
            throw new InvalidOperationException($"Windows no pudo iniciar llama-server. {launchError.Trim()}");
        using var process = Process.GetProcessById(serverPid);
        await File.WriteAllTextAsync(statePath, JsonSerializer.Serialize(new RunningServer(process.Id, info.FullName, true), JsonOptions));

        var deadline = DateTime.UtcNow.AddMinutes(3);
        while (DateTime.UtcNow < deadline)
        {
            if (process.HasExited)
            {
                var tail = ReadLogTail(stderrPath);
                DeleteState(statePath);
                throw new InvalidOperationException($"llama-server terminó durante el arranque (código {process.ExitCode}). {tail}");
            }
            if (await IsServerReady(http)) return new { ok = true, alreadyRunning = false, startedBySubVid = true };
            await Task.Delay(500);
        }
        TryKill(process);
        DeleteState(statePath);
        throw new TimeoutException($"llama-server no quedó listo en 3 minutos. {ReadLogTail(stderrPath)}");
    }

    private static async Task<object> StopAsync()
    {
        var config = LoadConfig();
        var statePath = Path.Combine(config.DataDirectory, "hymt2-server.json");
        if (!File.Exists(statePath)) return new { ok = true, stopped = false, detail = "SubVid no inició el servidor." };
        var state = JsonSerializer.Deserialize<RunningServer>(await File.ReadAllTextAsync(statePath), JsonOptions);
        if (state is null || !state.StartedBySubVid) return new { ok = true, stopped = false };
        try
        {
            using var process = Process.GetProcessById(state.ProcessId);
            var actualPath = process.MainModule?.FileName;
            if (!string.Equals(Path.GetFullPath(actualPath ?? ""), Path.GetFullPath(state.ServerPath), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("El PID guardado ya pertenece a otro proceso; no se detuvo por seguridad.");
            process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
        }
        catch (ArgumentException) { }
        finally { DeleteState(statePath); }
        return new { ok = true, stopped = true };
    }

    private static HostConfig LoadConfig()
    {
        if (!File.Exists(ConfigPath)) throw new FileNotFoundException("Falta la configuración. Ejecuta extension/native-host/install.ps1.", ConfigPath);
        var cfg = JsonSerializer.Deserialize<HostConfig>(File.ReadAllText(ConfigPath), JsonOptions);
        return cfg ?? throw new InvalidDataException("La configuración del host Hy-MT2 está vacía o dañada.");
    }

    private static async Task<bool> IsServerReady(HttpClient http)
    {
        try
        {
            using var response = await http.GetAsync($"{BaseUrl}/v1/models");
            if (!response.IsSuccessStatusCode) return false;
            using var payload = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync());
            return payload.RootElement.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.Array && data.GetArrayLength() > 0;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) { return false; }
    }

    private static async Task<bool> IsManagedServerRunning(HostConfig config)
    {
        try
        {
            var statePath = Path.Combine(config.DataDirectory, "hymt2-server.json");
            if (!File.Exists(statePath)) return false;
            var state = JsonSerializer.Deserialize<RunningServer>(await File.ReadAllTextAsync(statePath), JsonOptions);
            if (state is null || !state.StartedBySubVid || !string.Equals(Path.GetFullPath(state.ServerPath), Path.GetFullPath(config.ServerPath), StringComparison.OrdinalIgnoreCase)) return false;
            using var process = Process.GetProcessById(state.ProcessId);
            return !process.HasExited && string.Equals(Path.GetFullPath(process.MainModule?.FileName ?? ""), Path.GetFullPath(state.ServerPath), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static string PsQuote(string value) => "'" + value.Replace("'", "''") + "'";
    private static string WindowsArgQuote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";

    private static string ReadLogTail(string path)
    {
        try { return string.Join(" | ", File.ReadLines(path).TakeLast(12)); }
        catch { return "Consulta el log local de llama-server."; }
    }

    private static void TryKill(Process process)
    {
        try { process.Kill(entireProcessTree: true); } catch { }
    }

    private static void DeleteState(string path)
    {
        try { File.Delete(path); } catch { }
    }

    private static async Task ReadExactly(Stream stream, byte[] buffer)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var read = await stream.ReadAsync(buffer.AsMemory(offset));
            if (read == 0) throw new EndOfStreamException("Chrome cerró el canal Native Messaging.");
            offset += read;
        }
    }

    private static async Task WriteResponse<T>(T response)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(response, JsonOptions);
        var header = BitConverter.GetBytes(payload.Length);
        var output = Console.OpenStandardOutput();
        await output.WriteAsync(header);
        await output.WriteAsync(payload);
        await output.FlushAsync();
    }
}

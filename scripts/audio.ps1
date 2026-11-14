# Volumen del sistema y micrófono (Core Audio de Windows).
# Emite una línea JSON cada vez que cambia el estado y recibe órdenes por un socket local:
#   "vol 0.35"  -> fija el volumen (0..1)      "mute" -> alterna silencio de los altavoces
#   "mic"       -> alterna silencio del micrófono
param([int]$Port = 0)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Globalization;
using System.IO;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int f();
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

public static class GlassAudio {
    // dataFlow: 0 = altavoces, 1 = micrófono. Devuelve null si no hay dispositivo.
    static IAudioEndpointVolume Endpoint(int dataFlow) {
        try {
            IMMDeviceEnumerator enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
            IMMDevice dev = null;
            if (enumerator.GetDefaultAudioEndpoint(dataFlow, 1, out dev) != 0 || dev == null) return null;
            IAudioEndpointVolume epv = null;
            Guid id = typeof(IAudioEndpointVolume).GUID;
            if (dev.Activate(ref id, 23, 0, out epv) != 0) return null;
            return epv;
        } catch { return null; }
    }

    static string State() {
        string vol = "null", muted = "null", mic = "null";
        IAudioEndpointVolume o = Endpoint(0);
        if (o != null) {
            float v; bool m;
            if (o.GetMasterVolumeLevelScalar(out v) == 0) vol = ((int)Math.Round(v * 100)).ToString(CultureInfo.InvariantCulture);
            if (o.GetMute(out m) == 0) muted = m ? "true" : "false";
        }
        IAudioEndpointVolume i = Endpoint(1);
        if (i != null) {
            bool m;
            if (i.GetMute(out m) == 0) mic = m ? "true" : "false";
        }
        return "{\"volume\":" + vol + ",\"muted\":" + muted + ",\"micMuted\":" + mic + "}";
    }

    static void Handle(string line) {
        if (line.StartsWith("vol ")) {
            float v = float.Parse(line.Substring(4), CultureInfo.InvariantCulture);
            if (v < 0) v = 0;
            if (v > 1) v = 1;
            IAudioEndpointVolume o = Endpoint(0);
            if (o != null) {
                o.SetMasterVolumeLevelScalar(v, Guid.Empty);
                if (v > 0) o.SetMute(false, Guid.Empty);
            }
        } else if (line == "mute" || line == "mic") {
            IAudioEndpointVolume e = Endpoint(line == "mic" ? 1 : 0);
            bool m;
            if (e != null && e.GetMute(out m) == 0) e.SetMute(!m, Guid.Empty);
        }
    }

    static void ReadCommands(object portObj) {
        try {
            TcpClient client = new TcpClient("127.0.0.1", (int)portObj);
            StreamReader reader = new StreamReader(client.GetStream());
            string line;
            while ((line = reader.ReadLine()) != null) {
                try { Handle(line.Trim()); } catch { }
            }
        } catch { }
        Environment.Exit(0); // la app se cerró
    }

    public static void Run(int port) {
        if (port > 0) {
            Thread t = new Thread(ReadCommands);
            t.IsBackground = true;
            t.Start(port);
        }
        string last = "";
        while (true) {
            string s = State();
            if (s != last) {
                Console.Out.WriteLine(s);
                Console.Out.Flush();
                last = s;
            }
            Thread.Sleep(250);
        }
    }
}
'@

[GlassAudio]::Run($Port)

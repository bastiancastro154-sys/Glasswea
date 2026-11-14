# Lista las apps de la Tienda de Windows (las que no tienen acceso directo .lnk en el menú Inicio),
# con su icono en PNG. Devuelve un array JSON: [{ name, appId, icon }].
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$iconsOk = $false
try {
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class GlassIcons {
    [StructLayout(LayoutKind.Sequential)]
    struct SIZE { public int cx; public int cy; }

    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItemImageFactory {
        [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [In] ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);

    [DllImport("gdi32.dll")]
    static extern bool DeleteObject(IntPtr handle);

    // Devuelve el icono como "data:image/png;base64,..." o null.
    public static string Get(string parsingName, int size) {
        IntPtr hbm = IntPtr.Zero;
        try {
            Guid iid = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
            IShellItemImageFactory factory;
            SHCreateItemFromParsingName(parsingName, IntPtr.Zero, ref iid, out factory);
            SIZE s; s.cx = size; s.cy = size;
            if (factory.GetImage(s, 0x4, out hbm) != 0 || hbm == IntPtr.Zero) return null;
            using (Bitmap raw = Image.FromHbitmap(hbm)) {
                // FromHbitmap descarta la transparencia: se reinterpretan los mismos píxeles con canal alfa.
                Rectangle rect = new Rectangle(0, 0, raw.Width, raw.Height);
                BitmapData data = raw.LockBits(rect, ImageLockMode.ReadOnly, raw.PixelFormat);
                try {
                    Bitmap view = raw;
                    bool own = false;
                    if (Image.GetPixelFormatSize(raw.PixelFormat) == 32) {
                        view = new Bitmap(data.Width, data.Height, data.Stride, PixelFormat.Format32bppPArgb, data.Scan0);
                        own = true;
                    }
                    using (Bitmap copy = new Bitmap(view.Width, view.Height, PixelFormat.Format32bppArgb)) {
                        using (Graphics g = Graphics.FromImage(copy)) { g.DrawImage(view, 0, 0, view.Width, view.Height); }
                        if (own) view.Dispose();
                        using (MemoryStream ms = new MemoryStream()) {
                            copy.Save(ms, ImageFormat.Png);
                            return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
                        }
                    }
                } finally {
                    raw.UnlockBits(data);
                }
            }
        } catch {
            return null;
        } finally {
            if (hbm != IntPtr.Zero) DeleteObject(hbm);
        }
    }
}
'@
    $iconsOk = $true
} catch { }

$list = @()
foreach ($app in (Get-StartApps | Where-Object { $_.AppID -like '*!*' })) {
    $icon = $null
    if ($iconsOk) {
        try { $icon = [GlassIcons]::Get("shell:AppsFolder\" + $app.AppID, 48) } catch { }
    }
    $list += @{ name = [string]$app.Name; appId = [string]$app.AppID; icon = $icon }
}
ConvertTo-Json -Compress -InputObject @($list)

using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Collections.Generic;

internal static class IconRenderer
{
    private static GraphicsPath Rounded(float x, float y, float width, float height, float radius)
    {
        var path = new GraphicsPath(); float d = radius * 2;
        path.AddArc(x, y, d, d, 180, 90); path.AddArc(x + width - d, y, d, d, 270, 90);
        path.AddArc(x + width - d, y + height - d, d, d, 0, 90); path.AddArc(x, y + height - d, d, d, 90, 90);
        path.CloseFigure(); return path;
    }

    private static Bitmap Draw(int size)
    {
        using (var large = new Bitmap(size * 4, size * 4, PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(large))
            {
                g.Clear(Color.Transparent); g.SmoothingMode = SmoothingMode.AntiAlias;
                g.ScaleTransform(size * 4f / 256, size * 4f / 256);
                using (var shape = Rounded(8, 8, 240, 240, 56))
                using (var gradient = new LinearGradientBrush(new Point(32, 16), new Point(224, 248), Color.FromArgb(35, 208, 174), Color.FromArgb(7, 103, 108)))
                using (var edge = new Pen(Color.FromArgb(70, 255, 255, 255), 2))
                { g.FillPath(gradient, shape); g.DrawPath(edge, shape); }
                using (var pen = new Pen(Color.FromArgb(245, 255, 255, 255), 13))
                {
                    pen.StartCap = pen.EndCap = LineCap.Round; pen.LineJoin = LineJoin.Round;
                    using (var screen = new GraphicsPath())
                    {
                        screen.AddLine(60, 126, 60, 84); screen.AddArc(60, 64, 40, 40, 180, 90);
                        screen.AddLine(80, 64, 180, 64); screen.AddArc(160, 64, 40, 40, 270, 90);
                        screen.AddLine(200, 84, 200, 148); screen.AddArc(160, 128, 40, 40, 0, 90);
                        screen.AddLine(180, 168, 133, 168); g.DrawPath(pen, screen);
                    }
                    g.DrawLine(pen, 150, 168, 150, 188); g.DrawLine(pen, 132, 188, 170, 188);
                    g.DrawArc(pen, -8, 152, 80, 80, 270, 90); g.DrawArc(pen, -32, 128, 128, 128, 270, 90);
                }
                using (var white = new SolidBrush(Color.White))
                {
                    g.FillEllipse(white, 38, 188, 14, 14);
                    g.FillPolygon(white, new[] { new Point(118, 94), new Point(118, 140), new Point(153, 117) });
                }
            }
            var result = new Bitmap(size, size, PixelFormat.Format32bppArgb);
            using (var g = Graphics.FromImage(result))
            { g.CompositingMode = CompositingMode.SourceCopy; g.InterpolationMode = InterpolationMode.HighQualityBicubic; g.PixelOffsetMode = PixelOffsetMode.HighQuality; g.DrawImage(large, 0, 0, size, size); }
            return result;
        }
    }

    public static int Main(string[] args)
    {
        int[] sizes = { 16, 24, 32, 48, 64, 128, 256 }; var frames = new List<byte[]>();
        foreach (int size in sizes) using (var bitmap = Draw(size)) using (var memory = new MemoryStream())
        { bitmap.Save(memory, ImageFormat.Png); frames.Add(memory.ToArray()); if (size == 256 && args.Length > 1) bitmap.Save(args[1], ImageFormat.Png); }
        using (var writer = new BinaryWriter(File.Create(args[0])))
        {
            writer.Write((ushort)0); writer.Write((ushort)1); writer.Write((ushort)sizes.Length);
            int offset = 6 + sizes.Length * 16;
            for (int i = 0; i < sizes.Length; i++)
            { writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i])); writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i])); writer.Write((byte)0); writer.Write((byte)0); writer.Write((ushort)1); writer.Write((ushort)32); writer.Write(frames[i].Length); writer.Write(offset); offset += frames[i].Length; }
            foreach (byte[] frame in frames) writer.Write(frame);
        }
        return 0;
    }
}

font2header


ffmpeg -i tetoris.mp4 -vf "scale=320:240:flags=lanczos,palettegen=max_colors=16" -y palette.png
ffmpeg -i tetoris.mp4 -i palette.png -filter_complex "fps=30,scale=320:180:flags=lanczos[x];[x][1:v]paletteuse=dither=none" teto.gif

CLI
videoConverter/gif2rvv.js /home/spirit/Видео/dan.gif --output dan.rvv --bpp 8 --fps 24
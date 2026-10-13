# Kimi 品牌图形

仅用于标识会话所用的服务，不作为 Coda 自身标志。商标归各自权利人所有。

- `kimi-light.svg` / `kimi-dark.svg`：原样取自 [Kimi 品牌手册](https://www.kimi.com/resources/kimi-brand) 的官方 [素材包](https://kimi-file.kimi.ai/prod-chat-kimi/kfs/4/1/2026-08-12/1d9u74p1l51jas5cp5oq0?response-content-disposition=attachment%3Bfilename%3Dkimi-logo-assets.zip)，对应 `KIMI-logos/Logomark/SVG/Logomark_Light.svg` / `Logomark_Dark.svg`，用于 Kimi Code。保留圆角底板、字形及品牌蓝。

提取日期：2026-09-19。SVG 是可审阅的源文件，PDF 是由 CairoSVG 转换的等比矢量资源，清单的 `icon` 指向 PDF。重新生成 PDF（开发工具，不是构建或运行依赖）：

```sh
uv run --with cairosvg python - <<'PY'
import cairosvg
for name in ['kimi-light', 'kimi-dark']:
    cairosvg.svg2pdf(url=f'{name}.svg', write_to=f'{name}.pdf')
PY
```

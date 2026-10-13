# OpenCode 品牌图形

仅用于标识会话所用的服务，不作为 Coda 自身标志。商标归各自权利人所有。

- `opencode-light.svg` / `opencode-dark.svg`：原样取自 [OpenCode 品牌指南](https://opencode.ai/brand) 的官方 [素材包](https://opencode.ai/opencode-brand-assets.zip)，对应 `OpenCode Brand Assets/Logo/opencode-logo-light.svg` / `opencode-logo-dark.svg`；保留完整轮廓与双色结构。

提取日期：2026-09-19。SVG 是可审阅的源文件，PDF 是由 CairoSVG 转换的等比矢量资源，清单的 `icon` 指向 PDF。重新生成 PDF（开发工具，不是构建或运行依赖）：

```sh
uv run --with cairosvg python - <<'PY'
import cairosvg
for name in ['opencode-light', 'opencode-dark']:
    cairosvg.svg2pdf(url=f'{name}.svg', write_to=f'{name}.pdf')
PY
```

# Codex 品牌图形

仅用于标识会话所用的服务，不作为 Coda 自身标志。商标归各自权利人所有。

- `openai.svg`：取自 [OpenAI 品牌指南](https://openai.com/brand/) 展示的 [Blossom_Light.svg](https://images.ctfassets.net/kftzwdyauwt9/3hUGLn3ypllZ0oa01qOYVq/28e8188e6f11b84c3e876569d492734f/Blossom_Light.svg) 中的完整黑色 Blossom 路径。未包含指南的网格、尺寸辅助线和重复示例；保留路径几何。按产品约定用于 Codex。

提取日期：2026-09-19。SVG 是可审阅的源文件，PDF 是由 CairoSVG 转换的等比矢量资源，清单的 `icon` 指向 PDF。重新生成 PDF（开发工具，不是构建或运行依赖）：

```sh
uv run --with cairosvg python - <<'PY'
import cairosvg
for name in ['openai']:
    cairosvg.svg2pdf(url=f'{name}.svg', write_to=f'{name}.pdf')
PY
```

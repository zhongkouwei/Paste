# 图像处理测试样本

`foreground-mug.png` 是通过内置 image_gen 工具生成的合成商品图，不来自原版 Paste 的素材、私人剪贴板或真实用户照片。用于验证系统 Vision 前景分割：不透明背景应变透明，主体与把手孔分别保留/透空；边缘质量仍需更广样本和原版比较，不能只凭此图宣称完全准确。

生成 Prompt：

```text
Use case: product-mockup. Asset type: synthetic fixture for testing local foreground segmentation in a desktop image editor. Create one square photorealistic studio product photograph: a single red ceramic coffee mug, centered, fully visible including its open handle on the right, on a solid vivid yellow studio background and tabletop. The mug should occupy the middle 55 percent of the frame with generous clear background around every edge, sharp outlines, visible interior rim, realistic ceramic highlights and a soft short contact shadow. Camera level slightly above the mug so the handle hole is clearly visible. No other objects, no logos, no text, no watermark. Keep the corners entirely background. This is an opaque original source image, not a cutout and not a transparent image.
```

OCR 的中英文测试图由测试中的 Canvas 按固定尺寸和系统字体即时生成，不提交用户内容。

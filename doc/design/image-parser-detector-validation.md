# image-parser 非 ML 检测器接入验收

日期：2026-10-18。结论：**未达到替换正式自动扫描的要求**。新算法保留在 examples，正式路径仍为 Scanic classical；没有修改生产检测参数，也没有启用 ML。

## 验收范围与冻结版本

对象为 [page-lines.ts](../../libraries/image-parser/examples/page-lines.ts) 的纯 TS 长边检测原型。验收期间未修改其阈值、候选选择或评分，SHA-256：`f7d87c45419420db9889d5133aa068e4ab4bd043df59acce74f178a9a7305485`。代码能够识别先前的问题照片，不代表已满足通用扫描要求。

数据共68例：50个可重复合成场景、17张上游样图、1张用户照片。合成场景覆盖位置、旋转、尺度、分辨率、对比度、阴影、噪声、条纹/格线/杂物、出画和多个候选。弯曲纸张及多个候选采用保守策略：应拒绝自动确定目标，交给用户确认；这是一项产品验收要求，不是对其唯一正确行为的行业定义。

上游数据固定为 [Scanic testImages](https://github.com/marquaye/scanic/tree/dec0cd018899a7e1c5d8f4880223f0e54941f616/testImages)，commit `dec0cd018899a7e1c5d8f4880223f0e54941f616`。[标注文件](https://github.com/marquaye/scanic/blob/dec0cd018899a7e1c5d8f4880223f0e54941f616/testImages/ground-truth.json)称角点由 ML 预填后人工复核，17项均标有 reviewed；本项目未重新独立标注。标注文件 SHA-256 为 `b39e11dfaa9b8934eee40fd893514dba715774727b3b8bb33b0c13e01d6a006e`。评测推理全程不运行 ML，不上传图片。用户照片没有精确人工角点，只用于核验 partial 状态，不参与角点误差或 IoU 的统计。

## 本次工程门槛

这些阈值是本次接入审查预先设定的预算，不是行业统一标准，也不是通过单图调参得出的标准。

| 条件 | 要求 |
| --- | --- |
| 完整纸张定位 | 至少95%完整样本通过；每例可见纸面 IoU ≥0.90、覆盖率 ≥0.97、最大角点误差 ≤图像对角线的3% |
| 出画与歧义 | 出画应报告 partial；无法确定唯一目标时拒绝自动定框 |
| 误裁保护 | 不出现“返回完整框但明显漏纸面”，无纸张不自动框选 |
| 主线程开销 | 本次检测内核 P95 ≤100ms；另记录超过50ms的同步调用，必须评估 UI 响应与取消 |
| 接口 | partial 的外推坐标、预览、应用/完成和失败路径有明确契约与回归 |
| 浏览器 | Safari 真机及目标手机验证通过；桌面与CPU节流不能替代 |

[度量实现](../../libraries/image-parser/examples/paper-validation-metrics.ts)使用凸多边形精确裁切到可见图框，再算交集与并集。纸面覆盖率为交集/真实可见纸面面积，选区纯度为交集/预测可见面积。角点误差对循环起点匹配，避免把同一四边形起点变化误算为定位失败。空白帧、偏置漏检和返回错误完整框分别计数，不能只统计成功返回的样本。单位测试校验度量、出画契约和窄图行为。

## 准确性结果

| 组别 | 通过/总数 | 观察 |
| --- | --- | --- |
| 合成完整纸张 | 25/34 | 完整纸张总体未达到95%要求 |
| 其中：偏置位置 | 1/9 | 只有居中样本通过；按画面中心分边造成漏检 |
| 其中：旋转 | 9/9 | 在本次固定尺寸、背景和角度上通过，不代表任意旋转场景 |
| 合成出画纸张 | 0/6 | 5例返回完整框，1例未找到；没有正确报告 partial |
| 无纸张/歧义/范围外样本 | 7/10 | 杂物、弯曲顶部和多张纸被返回为完整框 |
| 上游真实样图 | 12/17 | 4例漏掉较多纸面，另1例带入过多背景 |
| 用户问题照片 | partial 状态通过 | 估计3个角在画面外，现有正式选区契约不能接收 |
| 全部场景 | 45/68 | 13例返回不应直接应用的完整框；无执行异常 |

13例是本次样本中“预期不是完整纸张却返回完整框，或纸面覆盖率不足97%”的计数，不是线上故障率。低对比、出画、无纸张干扰和歧义均有反例。合成数据与单一上游集没有覆盖所有手机、背景、透明/反光纸张或弯曲书页，不能据此声称通用准确率。

关键真实反例：

| 文件 | 新方案 IoU | 新方案纸面覆盖率 | 风险 |
| --- | --- | --- | --- |
| 0123.jpg | 0.488 | 48.8% | 返回完整框，漏掉约一半标注纸面 |
| 1023-receipt.jpg | 0.499 | 50.1% | 收据内容可能被裁掉 |
| IMG_0445 2.jpg | 0.745 | 75.6% | 完整框仍明显偏小 |
| test7.JPG | 0.827 | 83.1% | 仍漏掉纸面 |
| 25_2.jpg | 0.621 | 99.9% | 选区纯度仅62.2%，带入较多背景；旧方案此例通过 |

## 与正式方案逐图对照

对照使用 Scanic 1.7.1 的 classical、内部最长边800，并经过正式 validateSpec 的角点约束，采用同一组样本和同一几何门槛。[对照程序](../../libraries/image-parser/examples/paper-validation-baseline.ts)不比较 ML，也不以自定义评分代替定位真值。

68例中，正式 Scanic 通过36例，新原型通过45例；10例改善、1例回归。上游17张真实图分别通过10张与12张，其中25_2.jpg从通过变为失败。这表明长边路线有实际收益，仍不能据此默认替换。旧方案同样存在问题；本次审查结论并非认定旧方案已经达到上述新门槛。

## 性能与接口阻塞

性能在 Chromium155、相同800最长边处理平面上测量，记录纯检测内核，不包含图片解码、getImageData、透视导出、文件保存与渲染。JIT预热后逐例测量；最终桌面与4倍节流分别运行。共享机器负载会影响结果，不提供手机速度承诺。

| 运行条件 | P50 | P95 | 最大 | 同步超过50ms |
| --- | --- | --- | --- | --- |
| 桌面串行 | 50.3ms | 67.9ms | 92.5ms | 37/68 |
| 手机视口、CPU4倍节流串行 | 174.6ms | 226.9ms | 237.3ms | 63/68 |

节流不是Safari，也不是某款手机的测量。此前并发压力运行的数值更高，未作为这张性能表的依据。即使桌面数值通过100ms预算，算法同步执行期间也不能及时处理用户操作；正式接入应考虑 Worker 或可分段计算，并在宿主继续核验绑定、图片、参数代次及取消状态。

现有 [ImageDetection](../../libraries/image-parser/src/contracts.ts)只支持 detected/not-found；[UI 消费](../../libraries/image-parser/src/ui.ts)也按此处理。新原型的 complete/partial 不兼容，不能直接将返回值替换进去。用户照片的外推四角会被 [validateSpec](../../libraries/image-parser/src/validation.ts)以 invalid-selection 拒绝；强行把角点夹到[0,1]会改变几何含义，不能代替 partial 契约。还需决定不完整纸面的可见轮廓、全图保留、手动调整和重新拍摄如何呈现。

原型固定使用画面中心判定纸张内侧及四条边所属方向。非居中纸张可能无法分出四边；四边独立取最高票也可能拼接不同物体。颜色极性与固定梯度阈值使低对比场景退化成文字区域。峰值提取反复扫描Hough数组，存在可优化的开销，但本次未边测边改参数。

有效的4×800窄图会触发原型 RangeError，而正式检测应将不支持的形状映射为未找到或稳定错误分类。原型没有 AbortSignal/所有权接口；正式封装必须继续遵守现有读取、预算、迟到结果及资源释放约束。本次没有用旧路径的单测通过来替代新路径集成验证。

## 复现与交付

算法冻结；新增验收场景、度量测试、浏览器运行器、独立验收命令和本报告，没有更改正式检测路径或公开类型。

仅运行50个合成场景：

```bash
pnpm --filter @itookit/image-parser test:detector
```

命令会输出JSON路径并在验收失败时退出1。它是显式接入门槛，不等于普通单元测试失败，也不会在安装或普通test中下载样图。报告记录数值门槛、算法哈希及尚未完成的正式接口/浏览器验收项；即使数值门槛通过，也不会自动宣称生产就绪。

在仓库根目录准备固定上游样图并运行：

```bash
mkdir -p tmp/image-parser-validation/dataset
node libraries/image-parser/scripts/fetch-paper-validation-dataset.mjs \
  tmp/image-parser-validation/dataset /tmp/image-parser-validation/dataset/
IMAGE_PARSER_BROWSER_ROOT="$PWD" \
IMAGE_PARSER_INPUT_URL=/tmp/image-parser-validation/dataset/manifest.json \
IMAGE_PARSER_RESULT_FILE="$PWD/tmp/image-parser-validation/report.json" \
pnpm --filter @itookit/image-parser test:detector
```

这条命令默认只包含50个合成场景与17个上游样图。本次68例中的用户照片是额外登记项，expected=partial、points=null；不将其估计角点作为真值。手机视口压力运行再加 `IMAGE_PARSER_CPU_RATE=4 IMAGE_PARSER_MOBILE=1`。需要先完成前一运行，避免并发干扰性能；未提供样图时不声称跑过真实数据。

本次本地输出保存在 `tmp/image-parser-validation/`，包括desktop-serial.json、mobile-cpu4-serial.json、paired.json及review.html；目录被Git忽略，不把用户照片或上游样图复制进发布包。失败样本的HTML/图像便于逐图查看，JSON保留完整测量值。

下一步应先处理全局四边联合选择、偏置文档与质量拒绝，再完善 partial 和 Worker/取消契约，随后重跑同一冻结数据集及更多独立照片，并完成 Safari 真机。满足这些条件前，正式默认继续保留现有实现；新检测器仅用于实验候选及人工核对。

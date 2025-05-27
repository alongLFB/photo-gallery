# WebGL 图片查看器技术文档

## 概述

这是一个基于 WebGL 的高性能图片查看器，支持图片的缩放、平移、旋转等操作。相比传统的 DOM 或 Canvas 2D 方案，WebGL 方案能够提供更好的性能和更丰富的视觉效果。

## 为什么选择 WebGL？

### 传统方案的问题

1. **DOM 方案**：
   - 使用 `transform: scale()` 和 `translate()` 操作 `<img>` 元素
   - 优点：简单易用
   - 缺点：性能差，特别是在移动设备上；无法处理超大图片；缩放时图片质量下降

2. **Canvas 2D 方案**：
   - 使用 Canvas 2D API 绘制图片
   - 优点：比 DOM 方案性能更好
   - 缺点：仍然受 CPU 性能限制；无法充分利用 GPU

### WebGL 方案的优势

1. **GPU 加速**：所有图形运算都在 GPU 上进行，性能远超 CPU 方案
2. **高质量渲染**：支持硬件级别的图像插值和过滤
3. **内存效率**：纹理存储在 GPU 显存中，减少 CPU-GPU 数据传输
4. **可扩展性**：可以轻松添加滤镜、特效等高级功能

## 核心技术原理

### 1. WebGL 渲染管线

```
图片数据 → 纹理(Texture) → 顶点着色器 → 片段着色器 → 屏幕显示
```

#### 顶点着色器 (Vertex Shader)
```glsl
attribute vec2 a_position;    // 顶点位置
attribute vec2 a_texCoord;    // 纹理坐标

uniform mat3 u_matrix;        // 变换矩阵

varying vec2 v_texCoord;      // 传递给片段着色器的纹理坐标

void main() {
  vec3 position = u_matrix * vec3(a_position, 1.0);
  gl_Position = vec4(position.xy, 0, 1);
  v_texCoord = a_texCoord;
}
```

- **作用**：处理图片的几何变换（缩放、平移、旋转）
- **输入**：顶点位置和纹理坐标
- **输出**：变换后的顶点位置

#### 片段着色器 (Fragment Shader)
```glsl
precision mediump float;

uniform sampler2D u_image;    // 图片纹理
varying vec2 v_texCoord;      // 从顶点着色器传入的纹理坐标

void main() {
  gl_FragColor = texture2D(u_image, v_texCoord);
}
```

- **作用**：为每个像素采样纹理颜色
- **输入**：纹理坐标
- **输出**：像素颜色

### 2. 几何变换

图片被绘制在一个矩形（四边形）上，通过变换矩阵控制其在屏幕上的位置、大小和旋转：

```javascript
// 创建变换矩阵
const scaleX = (imageWidth * scale) / canvasWidth
const scaleY = (imageHeight * scale) / canvasHeight
const translateX = (this.translateX * 2) / canvasWidth
const translateY = -(this.translateY * 2) / canvasHeight

const matrix = [
  scaleX,     0,         0,
  0,          scaleY,    0,
  translateX, translateY, 1
]
```

### 3. LOD (Level of Detail) 系统

这是我们实现的核心优化技术，根据图片在屏幕上的显示大小动态选择合适分辨率的纹理。

#### LOD 级别配置
```javascript
const LOD_LEVELS = [
  { scale: 0.25, maxViewportScale: 0.5 },   // LOD 0: 1/4 分辨率
  { scale: 0.5,  maxViewportScale: 1 },     // LOD 1: 1/2 分辨率  
  { scale: 1,    maxViewportScale: 2 },     // LOD 2: 原始分辨率
  { scale: 2,    maxViewportScale: 4 },     // LOD 3: 2倍分辨率
  { scale: 4,    maxViewportScale: Infinity } // LOD 4: 4倍分辨率
]
```

#### LOD 选择算法
```javascript
private selectOptimalLOD(): number {
  const fitToScreenScale = this.getFitToScreenScale()
  const relativeScale = this.scale / fitToScreenScale

  for (let i = 0; i < this.LOD_LEVELS.length; i++) {
    if (relativeScale <= this.LOD_LEVELS[i].maxViewportScale) {
      return i
    }
  }
  return this.LOD_LEVELS.length - 1
}
```

#### LOD 的优势

1. **内存优化**：只保存当前需要的分辨率纹理
2. **性能优化**：低分辨率纹理渲染更快
3. **质量保证**：高倍缩放时使用高分辨率纹理保证清晰度
4. **带宽节省**：可以按需加载不同分辨率的图片

## 技术实现细节

### 1. 纹理管理

```javascript
class WebGLImageViewerEngine {
  private lodTextures = new Map<number, WebGLTexture>()
  private currentLOD = 0
  
  // 创建指定 LOD 级别的纹理
  private createLODTexture(lodLevel: number): WebGLTexture | null {
    const lodConfig = this.LOD_LEVELS[lodLevel]
    
    // 计算目标尺寸
    const lodWidth = Math.round(this.originalImage.width * lodConfig.scale)
    const lodHeight = Math.round(this.originalImage.height * lodConfig.scale)
    
    // 创建离屏 Canvas 进行图像缩放
    const offscreenCanvas = document.createElement('canvas')
    const ctx = offscreenCanvas.getContext('2d')
    
    // 设置渲染质量
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = lodConfig.scale >= 1 ? 'high' : 'medium'
    
    // 绘制缩放后的图像
    ctx.drawImage(originalImage, 0, 0, lodWidth, lodHeight)
    
    // 创建 WebGL 纹理
    const texture = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, offscreenCanvas)
    
    return texture
  }
}
```

### 2. 交互处理

#### 鼠标/触摸事件
- **缩放**：鼠标滚轮、双指捏合
- **平移**：拖拽
- **双击**：快速缩放到适应屏幕/原始大小

#### 坐标变换
```javascript
// 屏幕坐标转换为图片坐标
private screenToImageCoords(screenX: number, screenY: number) {
  const imageX = (screenX - this.canvasWidth/2 - this.translateX) / this.scale
  const imageY = (screenY - this.canvasHeight/2 - this.translateY) / this.scale
  return { x: imageX, y: imageY }
}

// 缩放时保持指定点不动
private zoomAt(x: number, y: number, scaleFactor: number) {
  const zoomPoint = this.screenToImageCoords(x, y)
  
  this.scale *= scaleFactor
  
  // 重新计算平移量，使缩放点保持不动
  this.translateX = x - this.canvasWidth/2 - zoomPoint.x * this.scale
  this.translateY = y - this.canvasHeight/2 - zoomPoint.y * this.scale
}
```

### 3. 性能优化

#### 渲染节流
```javascript
private render() {
  const now = performance.now()
  
  // 限制到 60fps
  if (now - this.lastRenderTime < 16) {
    if (this.renderThrottleId !== null) {
      cancelAnimationFrame(this.renderThrottleId)
    }
    this.renderThrottleId = requestAnimationFrame(() => this.renderInternal())
    return
  }
  
  this.renderInternal()
}
```

#### LOD 更新防抖
```javascript
private debouncedLODUpdate() {
  if (this.lodUpdateDebounceId !== null) {
    clearTimeout(this.lodUpdateDebounceId)
  }
  
  this.lodUpdateDebounceId = setTimeout(() => {
    this.updateLOD()
    this.render()
  }, 200) // 200ms 防抖
}
```

### 4. 边界约束

```javascript
private constrainImagePosition() {
  if (!this.config.limitToBounds) return

  const fitScale = this.getFitToScreenScale()
  
  // 如果图片小于屏幕，居中显示
  if (this.scale <= fitScale) {
    this.translateX = 0
    this.translateY = 0
    return
  }

  // 计算允许的最大平移量
  const scaledWidth = this.imageWidth * this.scale
  const scaledHeight = this.imageHeight * this.scale
  const maxTranslateX = Math.max(0, (scaledWidth - this.canvasWidth) / 2)
  const maxTranslateY = Math.max(0, (scaledHeight - this.canvasHeight) / 2)

  // 约束平移量
  this.translateX = Math.max(-maxTranslateX, Math.min(maxTranslateX, this.translateX))
  this.translateY = Math.max(-maxTranslateY, Math.min(maxTranslateY, this.translateY))
}
```

## 架构设计

### 组件结构

```
WebGLImageViewer (React 组件)
├── WebGLImageViewerEngine (核心引擎类)
│   ├── WebGL 上下文管理
│   ├── 着色器程序
│   ├── 纹理管理 (LOD 系统)
│   ├── 交互处理
│   └── 渲染循环
└── 调试信息显示
```

### 生命周期

1. **初始化**：创建 WebGL 上下文，编译着色器
2. **加载图片**：创建基础 LOD 纹理
3. **用户交互**：更新变换参数，触发重新渲染
4. **LOD 更新**：根据缩放级别创建/切换纹理
5. **销毁**：清理 WebGL 资源

## 配置选项

```typescript
interface WebGLImageViewerProps {
  src: string                    // 图片URL
  initialScale?: number          // 初始缩放比例
  minScale?: number             // 最小缩放比例
  maxScale?: number             // 最大缩放比例
  wheel?: WheelConfig           // 滚轮配置
  pinch?: PinchConfig           // 捏合配置
  doubleClick?: DoubleClickConfig // 双击配置
  panning?: PanningConfig       // 平移配置
  limitToBounds?: boolean       // 是否限制边界
  centerOnInit?: boolean        // 是否初始居中
  smooth?: boolean              // 是否启用平滑动画
  debug?: boolean               // 是否显示调试信息
}
```

## 兼容性

- **现代浏览器**：Chrome 20+, Firefox 15+, Safari 8+, Edge 12+
- **移动设备**：iOS Safari 8+, Android Chrome 25+
- **WebGL 支持**：自动检测，不支持时抛出错误

## 性能特点

1. **GPU 加速**：所有渲染在 GPU 进行
2. **内存效率**：LOD 系统减少内存占用
3. **渲染优化**：60fps 限制，避免过度渲染
4. **交互响应**：硬件加速的平移和缩放

## 扩展可能

1. **图像滤镜**：可在片段着色器中添加各种滤镜效果
2. **多图片**：支持图片切换和对比
3. **标注功能**：在 WebGL 上层添加 SVG/Canvas 标注
4. **3D 效果**：利用 WebGL 3D 能力添加景深等效果

## 总结

这个 WebGL 图片查看器通过以下核心技术实现了高性能的图片浏览体验：

1. **WebGL 渲染**：利用 GPU 硬件加速
2. **LOD 系统**：智能纹理管理，平衡性能和质量
3. **优化算法**：渲染节流、事件防抖等性能优化
4. **交互设计**：流畅的缩放、平移、动画效果

相比传统方案，这个实现在性能、质量和用户体验方面都有显著提升，特别适合需要处理大图片或要求高性能的应用场景。 
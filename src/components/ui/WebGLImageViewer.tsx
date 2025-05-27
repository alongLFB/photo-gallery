import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'

interface WheelConfig {
  step: number
  wheelDisabled?: boolean
  touchPadDisabled?: boolean
}

interface PinchConfig {
  step: number
  disabled?: boolean
}

interface DoubleClickConfig {
  step: number
  disabled?: boolean
  mode: 'toggle' | 'zoom'
  animationTime: number
}

interface PanningConfig {
  disabled?: boolean
  velocityDisabled?: boolean
}

interface AlignmentAnimationConfig {
  sizeX: number
  sizeY: number
  velocityAlignmentTime: number
}

interface VelocityAnimationConfig {
  sensitivity: number
  animationTime: number
}

interface WebGLImageViewerProps {
  src: string
  className?: string
  initialScale?: number
  minScale?: number
  maxScale?: number
  wheel?: WheelConfig
  pinch?: PinchConfig
  doubleClick?: DoubleClickConfig
  panning?: PanningConfig
  limitToBounds?: boolean
  centerOnInit?: boolean
  smooth?: boolean
  alignmentAnimation?: AlignmentAnimationConfig
  velocityAnimation?: VelocityAnimationConfig
  onZoomChange?: (originalScale: number, relativeScale: number) => void
  onImageCopied?: () => void
  debug?: boolean
}

interface WebGLImageViewerRef {
  zoomIn: (animated?: boolean) => void
  zoomOut: (animated?: boolean) => void
  resetView: () => void
  getScale: () => number
}

// WebGL Image Viewer implementation class
class WebGLImageViewerEngine {
  private canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext
  private program!: WebGLProgram
  private texture: WebGLTexture | null = null
  private imageLoaded = false
  private originalImageSrc = ''

  // Transform state
  private scale = 1
  private translateX = 0
  private translateY = 0
  private imageWidth = 0
  private imageHeight = 0
  private canvasWidth = 0
  private canvasHeight = 0

  // Interaction state
  private isDragging = false
  private lastMouseX = 0
  private lastMouseY = 0
  private lastTouchDistance = 0
  private lastDoubleClickTime = 0
  private isOriginalSize = false

  // Touch double-tap detection
  private lastTouchTime = 0
  private lastTouchX = 0
  private lastTouchY = 0
  private touchTapTimeout: ReturnType<typeof setTimeout> | null = null

  // Animation state
  private isAnimating = false
  private animationStartTime = 0
  private animationDuration = 300 // ms
  private startScale = 1
  private targetScale = 1
  private startTranslateX = 0
  private startTranslateY = 0
  private targetTranslateX = 0
  private targetTranslateY = 0

  // Throttle state for render
  private renderThrottleId: number | null = null
  private lastRenderTime = 0
  private renderThrottleDelay = 16 // ~60fps

  // LOD (Level of Detail) texture management
  private originalImage: HTMLImageElement | null = null
  private lodTextures = new Map<number, WebGLTexture>() // LOD level -> texture
  private currentLOD = 0
  private lodUpdateDebounceId: ReturnType<typeof setTimeout> | null = null
  private lodUpdateDelay = 200 // ms
  private maxTextureSize = 0 // WebGL maximum texture size

  // LOD levels configuration
  private readonly LOD_LEVELS = [
    { scale: 0.25, maxViewportScale: 0.5 }, // LOD 0: 1/4 resolution for very zoomed out
    { scale: 0.5, maxViewportScale: 1 }, // LOD 1: 1/2 resolution for zoomed out
    { scale: 1, maxViewportScale: 2 }, // LOD 2: full resolution for normal view
    { scale: 2, maxViewportScale: 4 }, // LOD 3: 2x resolution for zoomed in
    { scale: 4, maxViewportScale: Infinity }, // LOD 4: 4x resolution for very zoomed in
  ]

  // Configuration
  private config: Required<WebGLImageViewerProps>
  private onZoomChange?: (originalScale: number, relativeScale: number) => void
  private onImageCopied?: () => void
  private onDebugUpdate?: (debugInfo: any) => void

  // Bound event handlers for proper cleanup
  private boundHandleMouseDown: (e: MouseEvent) => void
  private boundHandleMouseMove: (e: MouseEvent) => void
  private boundHandleMouseUp: () => void
  private boundHandleWheel: (e: WheelEvent) => void
  private boundHandleDoubleClick: (e: MouseEvent) => void
  private boundHandleTouchStart: (e: TouchEvent) => void
  private boundHandleTouchMove: (e: TouchEvent) => void
  private boundHandleTouchEnd: (e: TouchEvent) => void
  private boundResizeCanvas: () => void

  // Vertex and fragment shaders
  private vertexShaderSource = `
    attribute vec2 a_position;
    attribute vec2 a_texCoord;
    
    uniform mat3 u_matrix;
    
    varying vec2 v_texCoord;
    
    void main() {
      vec3 position = u_matrix * vec3(a_position, 1.0);
      gl_Position = vec4(position.xy, 0, 1);
      v_texCoord = a_texCoord;
    }
  `

  private fragmentShaderSource = `
    precision mediump float;
    
    uniform sampler2D u_image;
    varying vec2 v_texCoord;
    
    void main() {
      gl_FragColor = texture2D(u_image, v_texCoord);
    }
  `

  constructor(
    canvas: HTMLCanvasElement,
    config: Required<WebGLImageViewerProps>,
    onZoomChange?: (originalScale: number, relativeScale: number) => void,
    onImageCopied?: () => void,
    onDebugUpdate?: (debugInfo: any) => void,
  ) {
    this.canvas = canvas
    this.config = config
    this.onZoomChange = onZoomChange
    this.onImageCopied = onImageCopied
    this.onDebugUpdate = onDebugUpdate

    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false, // 允许软件渲染作为后备
    })
    if (!gl) {
      throw new Error('WebGL not supported')
    }
    this.gl = gl

    // 获取 WebGL 最大纹理尺寸
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)

    // 在移动设备上记录一些有用的调试信息
    if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) {
      console.info('WebGL Image Viewer - Mobile device detected')
      console.info('Max texture size:', this.maxTextureSize)
      console.info('Device pixel ratio:', window.devicePixelRatio || 1)
      console.info(
        'Screen size:',
        window.screen.width,
        'x',
        window.screen.height,
      )
      console.info('WebGL renderer:', gl.getParameter(gl.RENDERER))
      console.info('WebGL vendor:', gl.getParameter(gl.VENDOR))
    }

    // 初始缩放将在图片加载时正确设置，这里先保持默认值
    // this.scale = config.initialScale

    // Bind event handlers for proper cleanup
    this.boundHandleMouseDown = (e: MouseEvent) => this.handleMouseDown(e)
    this.boundHandleMouseMove = (e: MouseEvent) => this.handleMouseMove(e)
    this.boundHandleMouseUp = () => this.handleMouseUp()
    this.boundHandleWheel = (e: WheelEvent) => this.handleWheel(e)
    this.boundHandleDoubleClick = (e: MouseEvent) => this.handleDoubleClick(e)
    this.boundHandleTouchStart = (e: TouchEvent) => this.handleTouchStart(e)
    this.boundHandleTouchMove = (e: TouchEvent) => this.handleTouchMove(e)
    this.boundHandleTouchEnd = (e: TouchEvent) => this.handleTouchEnd(e)
    this.boundResizeCanvas = () => this.resizeCanvas()

    this.setupCanvas()
    this.initWebGL()
    this.setupEventListeners()
  }

  private setupCanvas() {
    this.resizeCanvas()
    window.addEventListener('resize', this.boundResizeCanvas)
  }

  private resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect()
    const devicePixelRatio = window.devicePixelRatio || 1

    // 使用设备像素比来提高清晰度，特别是在高DPI屏幕上
    this.canvasWidth = rect.width
    this.canvasHeight = rect.height

    // 设置实际的canvas像素尺寸，考虑设备像素比
    const actualWidth = Math.round(rect.width * devicePixelRatio)
    const actualHeight = Math.round(rect.height * devicePixelRatio)

    this.canvas.width = actualWidth
    this.canvas.height = actualHeight
    this.gl.viewport(0, 0, actualWidth, actualHeight)

    if (this.imageLoaded) {
      // 窗口大小改变时，需要重新约束缩放倍数和位置
      this.constrainScaleAndPosition()
      this.render()
      // canvas尺寸变化时也需要检查LOD更新
      this.debouncedLODUpdate()
      // 通知缩放变化
      this.notifyZoomChange()
    }
  }

  private initWebGL() {
    const { gl } = this

    // Create shaders
    const vertexShader = this.createShader(
      gl.VERTEX_SHADER,
      this.vertexShaderSource,
    )
    const fragmentShader = this.createShader(
      gl.FRAGMENT_SHADER,
      this.fragmentShaderSource,
    )

    // Create program
    this.program = gl.createProgram()!
    gl.attachShader(this.program, vertexShader)
    gl.attachShader(this.program, fragmentShader)
    gl.linkProgram(this.program)

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(
        `Program linking failed: ${gl.getProgramInfoLog(this.program)}`,
      )
    }

    gl.useProgram(this.program)

    // Enable blending for transparency
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Create geometry (quad that will be transformed to image size)
    const positions = new Float32Array([
      -1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1,
    ])

    const texCoords = new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0])

    // Position buffer
    const positionBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)

    const positionLocation = gl.getAttribLocation(this.program, 'a_position')
    gl.enableVertexAttribArray(positionLocation)
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0)

    // Texture coordinate buffer
    const texCoordBuffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW)

    const texCoordLocation = gl.getAttribLocation(this.program, 'a_texCoord')
    gl.enableVertexAttribArray(texCoordLocation)
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0)
  }

  private createShader(type: number, source: string): WebGLShader {
    const { gl } = this
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, source)
    gl.compileShader(shader)

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error(`Shader compilation failed: ${error}`)
    }

    return shader
  }

  async loadImage(url: string) {
    this.originalImageSrc = url
    const image = new Image()
    image.crossOrigin = 'anonymous'

    return new Promise<void>((resolve, reject) => {
      image.onload = () => {
        this.imageWidth = image.width
        this.imageHeight = image.height

        // 先设置正确的缩放值，再创建纹理
        if (this.config.centerOnInit) {
          this.fitImageToScreen()
        } else {
          // 即使不居中，也需要将相对缩放转换为绝对缩放
          const fitToScreenScale = this.getFitToScreenScale()
          this.scale = fitToScreenScale * this.config.initialScale
        }

        this.createTexture(image)
        this.imageLoaded = true
        this.render()
        this.notifyZoomChange() // 通知初始缩放值
        resolve()
      }

      image.onerror = () => reject(new Error('Failed to load image'))
      image.src = url
    })
  }

  private createTexture(image: HTMLImageElement) {
    this.originalImage = image
    this.initializeLODTextures()
  }

  private initializeLODTextures() {
    if (!this.originalImage) return

    // 清理现有的 LOD 纹理
    this.cleanupLODTextures()

    // 创建基础 LOD 纹理（LOD 2: 原始分辨率）
    this.createLODTexture(2)
    this.currentLOD = 2
    this.texture = this.lodTextures.get(2) || null
  }

  private createLODTexture(lodLevel: number): WebGLTexture | null {
    if (
      !this.originalImage ||
      lodLevel < 0 ||
      lodLevel >= this.LOD_LEVELS.length
    ) {
      return null
    }

    const { gl } = this
    const lodConfig = this.LOD_LEVELS[lodLevel]

    try {
      // 计算 LOD 纹理尺寸
      const lodWidth = Math.max(
        1,
        Math.round(this.originalImage.width * lodConfig.scale),
      )
      const lodHeight = Math.max(
        1,
        Math.round(this.originalImage.height * lodConfig.scale),
      )

      // 确保不超过 WebGL 最大纹理尺寸
      const maxSize = Math.min(this.maxTextureSize, 4096) // 设置合理的上限
      const finalWidth = Math.min(lodWidth, maxSize)
      const finalHeight = Math.min(lodHeight, maxSize)

      // 创建离屏 canvas
      const offscreenCanvas = document.createElement('canvas')
      const offscreenCtx = offscreenCanvas.getContext('2d')!

      offscreenCanvas.width = finalWidth
      offscreenCanvas.height = finalHeight

      // 根据 LOD 级别选择渲染质量
      if (lodConfig.scale >= 1) {
        // 高分辨率 LOD，使用高质量渲染
        offscreenCtx.imageSmoothingEnabled = true
        offscreenCtx.imageSmoothingQuality = 'high'
      } else {
        // 低分辨率 LOD，使用快速渲染
        offscreenCtx.imageSmoothingEnabled = true
        offscreenCtx.imageSmoothingQuality = 'medium'
      }

      // 绘制图像到目标尺寸
      offscreenCtx.drawImage(
        this.originalImage,
        0,
        0,
        this.originalImage.width,
        this.originalImage.height,
        0,
        0,
        finalWidth,
        finalHeight,
      )

      // 创建 WebGL 纹理
      const texture = gl.createTexture()
      if (!texture) {
        console.error(`Failed to create LOD ${lodLevel} texture`)
        return null
      }

      gl.bindTexture(gl.TEXTURE_2D, texture)

      // 设置纹理参数
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

      // 根据 LOD 级别选择过滤方式
      if (lodConfig.scale >= 2) {
        // 高分辨率纹理，使用线性过滤获得平滑效果
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      } else if (lodConfig.scale < 1) {
        // 低分辨率纹理，使用线性过滤避免锯齿
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      } else {
        // 原始分辨率，根据图像类型选择
        const isPixelArt =
          this.originalImage.width < 512 || this.originalImage.height < 512
        if (isPixelArt) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        } else {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
        }
      }

      // 上传纹理数据
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        offscreenCanvas,
      )

      // 检查 WebGL 错误
      const error = gl.getError()
      if (error !== gl.NO_ERROR) {
        console.error(`WebGL error creating LOD ${lodLevel} texture:`, error)
        gl.deleteTexture(texture)
        return null
      }

      // 存储纹理
      this.lodTextures.set(lodLevel, texture)

      console.info(
        `Created LOD ${lodLevel} texture: ${finalWidth}×${finalHeight} (scale: ${lodConfig.scale})`,
      )
      return texture
    } catch (error) {
      console.error(`Error creating LOD ${lodLevel} texture:`, error)
      return null
    }
  }

  private cleanupLODTextures() {
    const { gl } = this

    // 删除所有现有的 LOD 纹理
    for (const [_level, texture] of this.lodTextures) {
      gl.deleteTexture(texture)
    }
    this.lodTextures.clear()

    // 清理主纹理引用
    this.texture = null
  }

  private selectOptimalLOD(): number {
    if (!this.originalImage) return 2 // 默认使用原始分辨率

    const fitToScreenScale = this.getFitToScreenScale()
    const relativeScale = this.scale / fitToScreenScale

    // 根据当前的视口缩放选择最佳的 LOD 级别
    for (let i = 0; i < this.LOD_LEVELS.length; i++) {
      if (relativeScale <= this.LOD_LEVELS[i].maxViewportScale) {
        return i
      }
    }

    // 如果超出所有级别，返回最高级别
    return this.LOD_LEVELS.length - 1
  }

  private updateLOD() {
    const optimalLOD = this.selectOptimalLOD()

    if (optimalLOD === this.currentLOD) {
      return // 无需更新
    }

    // 检查目标 LOD 纹理是否已存在
    let targetTexture = this.lodTextures.get(optimalLOD)

    if (!targetTexture) {
      // 创建新的 LOD 纹理
      const newTexture = this.createLODTexture(optimalLOD)
      if (newTexture) {
        targetTexture = newTexture
      }
    }

    if (targetTexture) {
      this.currentLOD = optimalLOD
      this.texture = targetTexture
      console.info(`Switched to LOD ${optimalLOD}`)
    }
  }

  private debouncedLODUpdate() {
    // 清除之前的防抖调用
    if (this.lodUpdateDebounceId !== null) {
      clearTimeout(this.lodUpdateDebounceId)
    }

    // 设置新的防抖调用
    this.lodUpdateDebounceId = setTimeout(() => {
      this.lodUpdateDebounceId = null
      this.updateLOD()
      this.render()
    }, this.lodUpdateDelay)
  }

  private fitImageToScreen() {
    const scaleX = this.canvasWidth / this.imageWidth
    const scaleY = this.canvasHeight / this.imageHeight
    const fitToScreenScale = Math.min(scaleX, scaleY)

    // initialScale 是相对于适应页面大小的比例
    this.scale = fitToScreenScale * this.config.initialScale

    // Center the image
    this.translateX = 0
    this.translateY = 0

    this.isOriginalSize = false
  }

  // Easing function for smooth animation
  private easeInOutCubic(t: number): number {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
  }

  private startAnimation(
    targetScale: number,
    targetTranslateX: number,
    targetTranslateY: number,
    animationTime?: number,
  ) {
    this.isAnimating = true
    this.animationStartTime = performance.now()
    this.animationDuration =
      animationTime ||
      (this.config.smooth
        ? this.config.velocityAnimation.animationTime * 1000
        : 0)
    this.startScale = this.scale
    this.targetScale = targetScale
    this.startTranslateX = this.translateX
    this.startTranslateY = this.translateY

    // Apply constraints to target position before starting animation
    const tempScale = this.scale
    const tempTranslateX = this.translateX
    const tempTranslateY = this.translateY

    this.scale = targetScale
    this.translateX = targetTranslateX
    this.translateY = targetTranslateY
    this.constrainImagePosition()

    this.targetTranslateX = this.translateX
    this.targetTranslateY = this.translateY

    // Restore current state
    this.scale = tempScale
    this.translateX = tempTranslateX
    this.translateY = tempTranslateY

    this.animate()
  }

  private animate() {
    if (!this.isAnimating) return

    const now = performance.now()
    const elapsed = now - this.animationStartTime
    const progress = Math.min(elapsed / this.animationDuration, 1)
    const easedProgress = this.config.smooth
      ? this.easeInOutCubic(progress)
      : progress

    // Interpolate scale and translation
    this.scale =
      this.startScale + (this.targetScale - this.startScale) * easedProgress
    this.translateX =
      this.startTranslateX +
      (this.targetTranslateX - this.startTranslateX) * easedProgress
    this.translateY =
      this.startTranslateY +
      (this.targetTranslateY - this.startTranslateY) * easedProgress

    this.render()
    this.notifyZoomChange()

    if (progress < 1) {
      requestAnimationFrame(() => this.animate())
    } else {
      this.isAnimating = false
      // Ensure final values are exactly the target values
      this.scale = this.targetScale
      this.translateX = this.targetTranslateX
      this.translateY = this.targetTranslateY
      this.render()
      this.notifyZoomChange()
      // 动画完成后触发LOD更新
      this.debouncedLODUpdate()
    }
  }

  private createMatrix(): Float32Array {
    // Create transformation matrix
    // 保持所有计算基于CSS尺寸，设备像素比的影响已经在canvas尺寸设置中处理
    const scaleX = (this.imageWidth * this.scale) / this.canvasWidth
    const scaleY = (this.imageHeight * this.scale) / this.canvasHeight

    const translateX = (this.translateX * 2) / this.canvasWidth
    const translateY = -(this.translateY * 2) / this.canvasHeight

    return new Float32Array([
      scaleX,
      0,
      0,
      0,
      scaleY,
      0,
      translateX,
      translateY,
      1,
    ])
  }

  private getFitToScreenScale(): number {
    const scaleX = this.canvasWidth / this.imageWidth
    const scaleY = this.canvasHeight / this.imageHeight
    return Math.min(scaleX, scaleY)
  }

  private constrainImagePosition() {
    if (!this.config.limitToBounds) return

    const fitScale = this.getFitToScreenScale()

    // If current scale is less than or equal to fit-to-screen scale, center the image
    if (this.scale <= fitScale) {
      this.translateX = 0
      this.translateY = 0
      return
    }

    // Otherwise, constrain the image within reasonable bounds
    const scaledWidth = this.imageWidth * this.scale
    const scaledHeight = this.imageHeight * this.scale

    // Calculate the maximum allowed translation to keep image edges within viewport
    const maxTranslateX = Math.max(0, (scaledWidth - this.canvasWidth) / 2)
    const maxTranslateY = Math.max(0, (scaledHeight - this.canvasHeight) / 2)

    // Constrain translation
    this.translateX = Math.max(
      -maxTranslateX,
      Math.min(maxTranslateX, this.translateX),
    )
    this.translateY = Math.max(
      -maxTranslateY,
      Math.min(maxTranslateY, this.translateY),
    )
  }

  private constrainScaleAndPosition() {
    // 首先约束缩放倍数
    const fitToScreenScale = this.getFitToScreenScale()
    const absoluteMinScale = fitToScreenScale * this.config.minScale
    const absoluteMaxScale = fitToScreenScale * this.config.maxScale

    // 如果当前缩放超出范围，调整到合理范围内
    if (this.scale < absoluteMinScale) {
      this.scale = absoluteMinScale
    } else if (this.scale > absoluteMaxScale) {
      this.scale = absoluteMaxScale
    }

    // 然后约束位置
    this.constrainImagePosition()
  }

  private render() {
    const now = performance.now()

    // 如果距离上次渲染时间不足，则使用节流
    if (now - this.lastRenderTime < this.renderThrottleDelay) {
      // 清除之前的节流调用
      if (this.renderThrottleId !== null) {
        cancelAnimationFrame(this.renderThrottleId)
      }

      // 安排下次渲染
      this.renderThrottleId = requestAnimationFrame(() => {
        this.renderThrottleId = null
        this.renderInternal()
      })
      return
    }

    this.renderInternal()
  }

  private renderInternal() {
    this.lastRenderTime = performance.now()

    const { gl } = this

    // 确保视口设置正确，使用实际的canvas像素尺寸
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)

    // 清除为完全透明
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    if (!this.texture) return

    gl.useProgram(this.program)

    // Set transformation matrix
    const matrixLocation = gl.getUniformLocation(this.program, 'u_matrix')
    gl.uniformMatrix3fv(matrixLocation, false, this.createMatrix())

    const imageLocation = gl.getUniformLocation(this.program, 'u_image')
    gl.uniform1i(imageLocation, 0)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)

    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // Update debug info if enabled
    if (this.config.debug && this.onDebugUpdate) {
      this.updateDebugInfo()
    }
  }

  private updateDebugInfo() {
    if (!this.onDebugUpdate) return

    const fitToScreenScale = this.getFitToScreenScale()
    const relativeScale = this.scale / fitToScreenScale

    this.onDebugUpdate({
      scale: this.scale,
      relativeScale,
      translateX: this.translateX,
      translateY: this.translateY,
      currentLOD: this.currentLOD,
      lodLevels: this.LOD_LEVELS.length,
      canvasSize: { width: this.canvasWidth, height: this.canvasHeight },
      imageSize: { width: this.imageWidth, height: this.imageHeight },
      fitToScreenScale,
      renderCount: performance.now(),
      maxTextureSize: this.maxTextureSize,
    })
  }

  private notifyZoomChange() {
    if (this.onZoomChange) {
      // 原图缩放比例（相对于图片原始大小）
      const originalScale = this.scale

      // 相对于页面适应大小的缩放比例
      const fitToScreenScale = this.getFitToScreenScale()
      const relativeScale = this.scale / fitToScreenScale

      this.onZoomChange(originalScale, relativeScale)
    }
  }

  private setupEventListeners() {
    // Mouse events
    this.canvas.addEventListener('mousedown', this.boundHandleMouseDown)
    this.canvas.addEventListener('mousemove', this.boundHandleMouseMove)
    this.canvas.addEventListener('mouseup', this.boundHandleMouseUp)
    this.canvas.addEventListener('wheel', this.boundHandleWheel)
    this.canvas.addEventListener('dblclick', this.boundHandleDoubleClick)

    // Touch events
    this.canvas.addEventListener('touchstart', this.boundHandleTouchStart)
    this.canvas.addEventListener('touchmove', this.boundHandleTouchMove)
    this.canvas.addEventListener('touchend', this.boundHandleTouchEnd)
  }

  private removeEventListeners() {
    this.canvas.removeEventListener('mousedown', this.boundHandleMouseDown)
    this.canvas.removeEventListener('mousemove', this.boundHandleMouseMove)
    this.canvas.removeEventListener('mouseup', this.boundHandleMouseUp)
    this.canvas.removeEventListener('wheel', this.boundHandleWheel)
    this.canvas.removeEventListener('dblclick', this.boundHandleDoubleClick)
    this.canvas.removeEventListener('touchstart', this.boundHandleTouchStart)
    this.canvas.removeEventListener('touchmove', this.boundHandleTouchMove)
    this.canvas.removeEventListener('touchend', this.boundHandleTouchEnd)
  }

  private handleMouseDown(e: MouseEvent) {
    if (this.isAnimating || this.config.panning.disabled) return

    // Stop any ongoing animation when user starts interacting
    this.isAnimating = false

    this.isDragging = true
    this.lastMouseX = e.clientX
    this.lastMouseY = e.clientY
  }

  private handleMouseMove(e: MouseEvent) {
    if (!this.isDragging || this.config.panning.disabled) return

    const deltaX = e.clientX - this.lastMouseX
    const deltaY = e.clientY - this.lastMouseY

    this.translateX += deltaX
    this.translateY += deltaY

    this.lastMouseX = e.clientX
    this.lastMouseY = e.clientY

    this.constrainImagePosition()
    this.render()
  }

  private handleMouseUp() {
    this.isDragging = false
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault()

    if (this.isAnimating || this.config.wheel.wheelDisabled) return

    const rect = this.canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    const scaleFactor =
      e.deltaY > 0 ? 1 - this.config.wheel.step : 1 + this.config.wheel.step
    this.zoomAt(mouseX, mouseY, scaleFactor)
  }

  private handleDoubleClick(e: MouseEvent) {
    e.preventDefault()

    if (this.config.doubleClick.disabled) return

    const now = Date.now()
    if (now - this.lastDoubleClickTime < 300) return
    this.lastDoubleClickTime = now

    const rect = this.canvas.getBoundingClientRect()
    const mouseX = e.clientX - rect.left
    const mouseY = e.clientY - rect.top

    this.performDoubleClickAction(mouseX, mouseY)
  }

  private handleTouchDoubleTap(clientX: number, clientY: number) {
    if (this.config.doubleClick.disabled) return

    const rect = this.canvas.getBoundingClientRect()
    const touchX = clientX - rect.left
    const touchY = clientY - rect.top

    this.performDoubleClickAction(touchX, touchY)
  }

  private performDoubleClickAction(x: number, y: number) {
    // Stop any ongoing animation
    this.isAnimating = false

    if (this.config.doubleClick.mode === 'toggle') {
      const fitToScreenScale = this.getFitToScreenScale()
      const absoluteMinScale = fitToScreenScale * this.config.minScale
      const absoluteMaxScale = fitToScreenScale * this.config.maxScale

      if (this.isOriginalSize) {
        // Animate to fit-to-screen 1x (适应页面大小) with click position as center
        const targetScale = Math.max(
          absoluteMinScale,
          Math.min(absoluteMaxScale, fitToScreenScale),
        )

        // Calculate zoom point relative to current transform
        const zoomX = (x - this.canvasWidth / 2 - this.translateX) / this.scale
        const zoomY = (y - this.canvasHeight / 2 - this.translateY) / this.scale

        // Calculate target translation after zoom
        const targetTranslateX = x - this.canvasWidth / 2 - zoomX * targetScale
        const targetTranslateY = y - this.canvasHeight / 2 - zoomY * targetScale

        this.startAnimation(
          targetScale,
          targetTranslateX,
          targetTranslateY,
          this.config.doubleClick.animationTime,
        )
        this.isOriginalSize = false
      } else {
        // Animate to original size 1x (原图原始大小) with click position as center
        const targetScale = Math.max(
          absoluteMinScale,
          Math.min(absoluteMaxScale, 1),
        ) // 1x = 原图原始大小

        // Calculate zoom point relative to current transform
        const zoomX = (x - this.canvasWidth / 2 - this.translateX) / this.scale
        const zoomY = (y - this.canvasHeight / 2 - this.translateY) / this.scale

        // Calculate target translation after zoom
        const targetTranslateX = x - this.canvasWidth / 2 - zoomX * targetScale
        const targetTranslateY = y - this.canvasHeight / 2 - zoomY * targetScale

        this.startAnimation(
          targetScale,
          targetTranslateX,
          targetTranslateY,
          this.config.doubleClick.animationTime,
        )
        this.isOriginalSize = true
      }
    } else {
      // Zoom mode
      this.zoomAt(x, y, this.config.doubleClick.step)
    }
  }

  private handleTouchStart(e: TouchEvent) {
    e.preventDefault()

    if (this.isAnimating) return

    if (e.touches.length === 1 && !this.config.panning.disabled) {
      const touch = e.touches[0]
      const now = Date.now()

      // Check for double-tap
      if (
        !this.config.doubleClick.disabled &&
        now - this.lastTouchTime < 300 &&
        Math.abs(touch.clientX - this.lastTouchX) < 50 &&
        Math.abs(touch.clientY - this.lastTouchY) < 50
      ) {
        // Double-tap detected
        this.handleTouchDoubleTap(touch.clientX, touch.clientY)
        this.lastTouchTime = 0 // Reset to prevent triple-tap
        return
      }

      // Single touch - prepare for potential drag or single tap
      this.isDragging = true
      this.lastMouseX = touch.clientX
      this.lastMouseY = touch.clientY
      this.lastTouchTime = now
      this.lastTouchX = touch.clientX
      this.lastTouchY = touch.clientY
    } else if (e.touches.length === 2 && !this.config.pinch.disabled) {
      this.isDragging = false
      const touch1 = e.touches[0]
      const touch2 = e.touches[1]
      this.lastTouchDistance = Math.sqrt(
        Math.pow(touch2.clientX - touch1.clientX, 2) +
          Math.pow(touch2.clientY - touch1.clientY, 2),
      )
    }
  }

  private handleTouchMove(e: TouchEvent) {
    e.preventDefault()

    if (
      e.touches.length === 1 &&
      this.isDragging &&
      !this.config.panning.disabled
    ) {
      const deltaX = e.touches[0].clientX - this.lastMouseX
      const deltaY = e.touches[0].clientY - this.lastMouseY

      this.translateX += deltaX
      this.translateY += deltaY

      this.lastMouseX = e.touches[0].clientX
      this.lastMouseY = e.touches[0].clientY

      this.constrainImagePosition()
      this.render()
    } else if (e.touches.length === 2 && !this.config.pinch.disabled) {
      const touch1 = e.touches[0]
      const touch2 = e.touches[1]
      const distance = Math.sqrt(
        Math.pow(touch2.clientX - touch1.clientX, 2) +
          Math.pow(touch2.clientY - touch1.clientY, 2),
      )

      if (this.lastTouchDistance > 0) {
        const scaleFactor = distance / this.lastTouchDistance
        const centerX = (touch1.clientX + touch2.clientX) / 2
        const centerY = (touch1.clientY + touch2.clientY) / 2

        const rect = this.canvas.getBoundingClientRect()
        this.zoomAt(centerX - rect.left, centerY - rect.top, scaleFactor)
      }

      this.lastTouchDistance = distance
    }
  }

  private handleTouchEnd(_e: TouchEvent) {
    this.isDragging = false
    this.lastTouchDistance = 0

    // Clear any pending touch tap timeout
    if (this.touchTapTimeout) {
      clearTimeout(this.touchTapTimeout)
      this.touchTapTimeout = null
    }
  }

  private zoomAt(x: number, y: number, scaleFactor: number, animated = false) {
    const newScale = this.scale * scaleFactor
    const fitToScreenScale = this.getFitToScreenScale()

    // 将相对缩放比例转换为绝对缩放比例进行限制
    const absoluteMinScale = fitToScreenScale * this.config.minScale
    const absoluteMaxScale = fitToScreenScale * this.config.maxScale

    // Limit zoom
    if (newScale < absoluteMinScale || newScale > absoluteMaxScale) return

    if (animated && this.config.smooth) {
      // Calculate zoom point relative to current transform
      const zoomX = (x - this.canvasWidth / 2 - this.translateX) / this.scale
      const zoomY = (y - this.canvasHeight / 2 - this.translateY) / this.scale

      // Calculate target translation after zoom
      const targetTranslateX = x - this.canvasWidth / 2 - zoomX * newScale
      const targetTranslateY = y - this.canvasHeight / 2 - zoomY * newScale

      this.startAnimation(newScale, targetTranslateX, targetTranslateY)
    } else {
      // Calculate zoom point relative to current transform
      const zoomX = (x - this.canvasWidth / 2 - this.translateX) / this.scale
      const zoomY = (y - this.canvasHeight / 2 - this.translateY) / this.scale

      this.scale = newScale

      // Adjust translation to keep zoom point fixed
      this.translateX = x - this.canvasWidth / 2 - zoomX * this.scale
      this.translateY = y - this.canvasHeight / 2 - zoomY * this.scale

      this.constrainImagePosition()
      this.render()
      this.notifyZoomChange()
      this.debouncedLODUpdate()
    }
  }

  async copyOriginalImageToClipboard() {
    try {
      // 获取原始图片
      const response = await fetch(this.originalImageSrc)
      const blob = await response.blob()

      // 检查浏览器是否支持剪贴板API
      if (!navigator.clipboard || !navigator.clipboard.write) {
        console.warn('Clipboard API not supported')
        return
      }

      // 创建ClipboardItem并写入剪贴板
      const clipboardItem = new ClipboardItem({
        [blob.type]: blob,
      })

      await navigator.clipboard.write([clipboardItem])
      console.info('Original image copied to clipboard')
      if (this.onImageCopied) {
        this.onImageCopied()
      }
    } catch (error) {
      console.error('Failed to copy image to clipboard:', error)
    }
  }

  // Public methods
  public zoomIn(animated = false) {
    const centerX = this.canvasWidth / 2
    const centerY = this.canvasHeight / 2
    this.zoomAt(centerX, centerY, 1 + this.config.wheel.step, animated)
  }

  public zoomOut(animated = false) {
    const centerX = this.canvasWidth / 2
    const centerY = this.canvasHeight / 2
    this.zoomAt(centerX, centerY, 1 - this.config.wheel.step, animated)
  }

  public resetView() {
    const fitToScreenScale = this.getFitToScreenScale()
    const targetScale = fitToScreenScale * this.config.initialScale
    this.startAnimation(targetScale, 0, 0)
  }

  public getScale(): number {
    return this.scale
  }

  public destroy() {
    this.removeEventListeners()
    window.removeEventListener('resize', this.boundResizeCanvas)

    // 清理节流相关的资源
    if (this.renderThrottleId !== null) {
      cancelAnimationFrame(this.renderThrottleId)
      this.renderThrottleId = null
    }

    // 清理LOD更新防抖相关的资源
    if (this.lodUpdateDebounceId !== null) {
      clearTimeout(this.lodUpdateDebounceId)
      this.lodUpdateDebounceId = null
    }

    // 清理触摸双击相关的资源
    if (this.touchTapTimeout !== null) {
      clearTimeout(this.touchTapTimeout)
      this.touchTapTimeout = null
    }

    // 清理 WebGL 资源
    this.cleanupLODTextures()
  }
}

const defaultWheelConfig: WheelConfig = {
  step: 0.1,
  wheelDisabled: false,
  touchPadDisabled: false,
}

const defaultPinchConfig: PinchConfig = {
  step: 0.5,
  disabled: false,
}

const defaultDoubleClickConfig: DoubleClickConfig = {
  step: 2,
  disabled: false,
  mode: 'toggle',
  animationTime: 200,
}

const defaultPanningConfig: PanningConfig = {
  disabled: false,
  velocityDisabled: true,
}

const defaultAlignmentAnimation: AlignmentAnimationConfig = {
  sizeX: 0,
  sizeY: 0,
  velocityAlignmentTime: 0.2,
}

const defaultVelocityAnimation: VelocityAnimationConfig = {
  sensitivity: 1,
  animationTime: 0.2,
}

export const WebGLImageViewer = ({
  ref,
  src,
  className = '',
  initialScale = 1,
  minScale = 0.1,
  maxScale = 10,
  wheel = defaultWheelConfig,
  pinch = defaultPinchConfig,
  doubleClick = defaultDoubleClickConfig,
  panning = defaultPanningConfig,
  limitToBounds = true,
  centerOnInit = true,
  smooth = true,
  alignmentAnimation = defaultAlignmentAnimation,
  velocityAnimation = defaultVelocityAnimation,
  onZoomChange,
  onImageCopied,
  debug = false,
}: WebGLImageViewerProps & {
  ref?: React.RefObject<WebGLImageViewerRef | null>
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<WebGLImageViewerEngine | null>(null)
  const [debugInfo, setDebugInfo] = useState({
    scale: 1,
    relativeScale: 1,
    translateX: 0,
    translateY: 0,
    currentLOD: 0,
    lodLevels: 0,
    canvasSize: { width: 0, height: 0 },
    imageSize: { width: 0, height: 0 },
    fitToScreenScale: 1,
    renderCount: 0,
    maxTextureSize: 0,
  })

  const config: Required<WebGLImageViewerProps> = useMemo(
    () => ({
      src,
      className,
      initialScale,
      minScale,
      maxScale,
      wheel: {
        ...defaultWheelConfig,
        ...wheel,
      },
      pinch: { ...defaultPinchConfig, ...pinch },
      doubleClick: { ...defaultDoubleClickConfig, ...doubleClick },
      panning: { ...defaultPanningConfig, ...panning },
      limitToBounds,
      centerOnInit,
      smooth,
      alignmentAnimation: {
        ...defaultAlignmentAnimation,
        ...alignmentAnimation,
      },
      velocityAnimation: { ...defaultVelocityAnimation, ...velocityAnimation },
      onZoomChange: onZoomChange || (() => {}),
      onImageCopied: onImageCopied || (() => {}),
      debug: debug || false,
    }),
    [
      src,
      className,
      initialScale,
      minScale,
      maxScale,
      wheel,
      pinch,
      doubleClick,
      panning,
      limitToBounds,
      centerOnInit,
      smooth,
      alignmentAnimation,
      velocityAnimation,
      onZoomChange,
      onImageCopied,
      debug,
    ],
  )

  useImperativeHandle(ref, () => ({
    zoomIn: (animated?: boolean) => viewerRef.current?.zoomIn(animated),
    zoomOut: (animated?: boolean) => viewerRef.current?.zoomOut(animated),
    resetView: () => viewerRef.current?.resetView(),
    getScale: () => viewerRef.current?.getScale() || 1,
  }))

  useEffect(() => {
    if (!canvasRef.current) return

    let webGLImageViewerEngine: WebGLImageViewerEngine | null = null
    try {
      webGLImageViewerEngine = new WebGLImageViewerEngine(
        canvasRef.current,
        config,
        onZoomChange,
        onImageCopied,
        debug ? setDebugInfo : undefined,
      )
      webGLImageViewerEngine.loadImage(src).catch(console.error)
      viewerRef.current = webGLImageViewerEngine
    } catch (error) {
      console.error('Failed to initialize WebGL Image Viewer:', error)
    }

    return () => {
      webGLImageViewerEngine?.destroy()
    }
  }, [src, config, onZoomChange, onImageCopied])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        className={className}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          touchAction: 'none',
          border: 'none',
          outline: 'none',
          margin: 0,
          padding: 0,
          // 对于像素艺术和小图片保持锐利，使用最新的标准属性
          imageRendering: 'pixelated',
        }}
      />
      {debug && (
        <div
          style={{
            position: 'absolute',
            top: '10px',
            left: '10px',
            background: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '10px',
            borderRadius: '4px',
            fontSize: '12px',
            fontFamily: 'monospace',
            lineHeight: '1.4',
            pointerEvents: 'none',
            zIndex: 1000,
            minWidth: '200px',
          }}
        >
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>
            WebGL Debug Info
          </div>
          <div>Scale: {debugInfo.scale.toFixed(3)}</div>
          <div>Relative Scale: {debugInfo.relativeScale.toFixed(3)}</div>
          <div>
            Translate: ({debugInfo.translateX.toFixed(1)},{' '}
            {debugInfo.translateY.toFixed(1)})
          </div>
          <div>
            Canvas CSS: {debugInfo.canvasSize.width}×
            {debugInfo.canvasSize.height}
          </div>
          <div>
            Canvas Actual: {canvasRef.current?.width || 0}×
            {canvasRef.current?.height || 0}
          </div>
          <div>Device Pixel Ratio: {window.devicePixelRatio || 1}</div>
          <div>
            Image: {debugInfo.imageSize.width}×{debugInfo.imageSize.height}
          </div>
          <div>
            Current LOD: {debugInfo.currentLOD} / {debugInfo.lodLevels - 1}
          </div>
          <div>Max Texture Size: {debugInfo.maxTextureSize}</div>
          <div>Fit Scale: {debugInfo.fitToScreenScale.toFixed(3)}</div>
        </div>
      )}
    </div>
  )
}

WebGLImageViewer.displayName = 'WebGLImageViewer'

export type { WebGLImageViewerProps, WebGLImageViewerRef }

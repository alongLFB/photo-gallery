import { AnimatePresence, m, useAnimationControls } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { clsxm } from '~/lib/cn'
import {
  convertHeicImage,
  detectHeicFormat,
  isBrowserSupportHeic,
  revokeConvertedUrl,
} from '~/lib/heic-converter'
import { Spring } from '~/lib/spring'

import type { WebGLImageViewerRef } from '../WebGLImageViewer'
import { WebGLImageViewer } from '../WebGLImageViewer'

const canUseWebGL = (() => {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl')
  return gl !== null
})()
interface ProgressiveImageProps {
  src: string
  thumbnailSrc?: string

  alt: string
  width?: number
  height?: number
  className?: string
  onError?: () => void
  onProgress?: (progress: number) => void
  onZoomChange?: (isZoomed: boolean) => void

  enableZoom?: boolean
  enablePan?: boolean
  maxZoom?: number
  minZoom?: number

  isCurrentImage?: boolean
}

export const ProgressiveImage = ({
  src,
  thumbnailSrc,

  alt,
  className,

  onError,
  onProgress,
  onZoomChange,

  maxZoom = 20,
  minZoom = 1,
  isCurrentImage = false,
}: ProgressiveImageProps) => {
  const [blobSrc, setBlobSrc] = useState<string | null>(null)
  const [highResLoaded, setHighResLoaded] = useState(false)
  const [error, setError] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState(0)
  const [isHeicFormat, setIsHeicFormat] = useState(false)
  const [isConverting, setIsConverting] = useState(false)

  const thumbnailRef = useRef<HTMLImageElement>(null)

  const transformRef = useRef<WebGLImageViewerRef>(null)
  const thumbnailAnimateController = useAnimationControls()
  const convertedUrlRef = useRef<string | null>(null)

  // Reset states when image changes
  useEffect(() => {
    setHighResLoaded(false)
    setBlobSrc(null)
    setError(false)
    setLoadingProgress(0)
    setIsHeicFormat(false)
    setIsConverting(false)

    // Clean up previous converted URL
    if (convertedUrlRef.current) {
      revokeConvertedUrl(convertedUrlRef.current)
      convertedUrlRef.current = null
    }

    // Reset transform when image changes
    if (transformRef.current) {
      transformRef.current.resetView()
    }
  }, [src])

  useEffect(() => {
    if (highResLoaded || error || !isCurrentImage) return

    let upperXHR: XMLHttpRequest | null = null

    const delayToLoadTimer = setTimeout(async () => {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', src)
      xhr.responseType = 'blob'
      xhr.onload = async () => {
        if (xhr.status === 200) {
          const blob = xhr.response

          try {
            // 检测是否为 HEIC 格式
            const shouldHeicTransformed =
              !isBrowserSupportHeic() && (await detectHeicFormat(blob))

            setIsHeicFormat(shouldHeicTransformed)

            if (shouldHeicTransformed) {
              // 如果是 HEIC 格式，进行转换
              setIsConverting(true)
              try {
                const conversionResult = await convertHeicImage(blob)

                convertedUrlRef.current = conversionResult.url
                setBlobSrc(conversionResult.url)
                setHighResLoaded(true)
                setIsConverting(false)

                console.info(
                  `HEIC converted: ${(blob.size / 1024).toFixed(1)}KB → ${(conversionResult.convertedSize / 1024).toFixed(1)}KB`,
                )
              } catch (conversionError) {
                console.error('HEIC conversion failed:', conversionError)
                setError(true)
                setIsConverting(false)
                onError?.()
              }
            } else {
              // 普通图片格式
              const url = URL.createObjectURL(blob)

              setBlobSrc(url)
              setHighResLoaded(true)
            }
          } catch (detectionError) {
            console.error('Format detection failed:', detectionError)
            // 如果检测失败，按普通图片处理
            const url = URL.createObjectURL(blob)

            setBlobSrc(url)
            setHighResLoaded(true)
          }
        }
      }

      xhr.onprogress = (e) => {
        if (e.lengthComputable) {
          const progress = (e.loaded / e.total) * 100
          setLoadingProgress(progress)
          onProgress?.(progress)
        }
      }
      xhr.onerror = () => {
        setError(true)
        onError?.()
      }
      xhr.send()

      upperXHR = xhr
    }, 300)
    return () => {
      clearTimeout(delayToLoadTimer)
      upperXHR?.abort()
    }
  }, [highResLoaded, error, onProgress, src, onError, isCurrentImage])

  const onTransformed = useCallback(
    (originalScale: number, relativeScale: number) => {
      const isZoomed = Math.abs(relativeScale - 1) > 0.01

      onZoomChange?.(isZoomed)
    },
    [onZoomChange],
  )

  const handleThumbnailLoad = useCallback(() => {
    thumbnailAnimateController.start({
      opacity: 1,
    })
  }, [thumbnailAnimateController])

  if (error) {
    return (
      <div
        className={clsxm(
          'flex items-center justify-center bg-material-opaque',
          className,
        )}
      >
        <div className="text-center text-text-secondary">
          <i className="i-mingcute-image-line text-4xl mb-2" />
          <p className="text-sm">图片加载失败</p>
        </div>
      </div>
    )
  }

  return (
    <div className={clsxm('relative overflow-hidden', className)}>
      {/* 缩略图 */}
      {thumbnailSrc && (
        <m.img
          ref={thumbnailRef}
          initial={{ opacity: 0 }}
          exit={{ opacity: 0 }}
          src={thumbnailSrc}
          key={thumbnailSrc}
          alt={alt}
          transition={Spring.presets.smooth}
          className="absolute inset-0 w-full h-full object-contain"
          animate={thumbnailAnimateController}
          onLoad={handleThumbnailLoad}
        />
      )}

      {highResLoaded && blobSrc && (
        <WebGLImageViewer
          ref={transformRef}
          src={blobSrc}
          className="absolute inset-0 w-full h-full"
          initialScale={1}
          minScale={minZoom}
          maxScale={maxZoom}
          limitToBounds={true}
          centerOnInit={true}
          smooth={true}
          onZoomChange={onTransformed}
          debug={import.meta.env.DEV}
        />
      )}

      {/* 备用图片（当 WebGL 不可用时） */}
      {!canUseWebGL && highResLoaded && blobSrc && (
        <div className="absolute inset-0 flex-col gap-2 flex items-center justify-center bg-black/20 z-10 pointer-events-none">
          <i className="i-mingcute-warning-line text-4xl mb-2" />
          <span className="text-white text-sm text-center">
            WebGL 不可用，无法渲染图片
          </span>
        </div>
      )}

      {/* 加载指示器 */}
      <AnimatePresence>
        {!highResLoaded && !error && isCurrentImage && (
          <m.div
            className="absolute top-1/2 left-1/2 p-4 rounded-lg -translate-x-1/2 -translate-y-1/2 flex items-center justify-center bg-black/50 backdrop-blur-3xl z-10 pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={Spring.presets.snappy}
          >
            <div className="text-center text-white">
              <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin mx-auto mb-2" />
              {isConverting ? (
                <>
                  <p className="text-sm">正在转换 HEIC 图片...</p>
                </>
              ) : isHeicFormat ? (
                <>
                  <p className="text-sm">正在下载 HEIC 图片...</p>
                  <p className="text-xs text-white/70 mt-1">
                    {Math.round(loadingProgress)}%
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm">正在加载高清图片...</p>
                  <p className="text-xs text-white/70 mt-1">
                    {Math.round(loadingProgress)}%
                  </p>
                </>
              )}
            </div>
          </m.div>
        )}
      </AnimatePresence>

      {/* 缩放提示 */}

      <div className="absolute bottom-4 duration-200 opacity-0 group-hover:opacity-50 left-1/2 transform -translate-x-1/2 bg-black/50 text-white text-xs px-2 py-1 rounded pointer-events-none z-20">
        双击或双指缩放
      </div>
    </div>
  )
}

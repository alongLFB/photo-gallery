import { heicTo, isHeic } from 'heic-to'

export interface HeicConversionOptions {
  quality?: number
  format?: 'image/jpeg' | 'image/png'
}

export interface ConversionResult {
  blob: Blob
  url: string
  originalSize: number
  convertedSize: number
  format: string
}

/**
 * 检测文件是否为 HEIC/HEIF 格式
 */
export async function detectHeicFormat(file: File | Blob): Promise<boolean> {
  try {
    return await isHeic(file as File)
  } catch (error) {
    console.warn('Failed to detect HEIC format:', error)
    return false
  }
}

export const isBrowserSupportHeic = () => {
  const isSafari = /^(?:(?!chrome|android).)*safari/i.test(navigator.userAgent)
  const safariVersionMatch = navigator.userAgent.match(/version\/(\d+)/i)
  const versionString = safariVersionMatch?.[1]
  const version = versionString ? Number.parseInt(versionString, 10) : 0

  return isSafari && version >= 17
}

/**
 * 将 HEIC/HEIF 图片转换为 JPEG 或 PNG
 */
export async function convertHeicImage(
  file: File | Blob,
  options: HeicConversionOptions = {},
): Promise<ConversionResult> {
  const { quality = 1, format = 'image/jpeg' } = options

  try {
    // 检查是否为 HEIC 格式
    const isHeicFormat = await detectHeicFormat(file)
    if (!isHeicFormat) {
      throw new Error('File is not in HEIC/HEIF format')
    }

    // 转换图片
    const convertedBlob = await heicTo({
      blob: file,
      type: format,
      quality,
    })

    // 创建 URL
    const url = URL.createObjectURL(convertedBlob)

    return {
      blob: convertedBlob,
      url,
      originalSize: file.size,
      convertedSize: convertedBlob.size,
      format,
    }
  } catch (error) {
    console.error('HEIC conversion failed:', error)
    throw new Error(
      `Failed to convert HEIC image: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }
}

/**
 * 清理转换后的 URL
 */
export function revokeConvertedUrl(url: string): void {
  try {
    URL.revokeObjectURL(url)
  } catch (error) {
    console.warn('Failed to revoke URL:', error)
  }
}

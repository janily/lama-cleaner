import {
  ArrowsExpandIcon,
  DownloadIcon,
  EyeIcon,
} from '@heroicons/react/outline'
import React, {
  SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  ReactZoomPanPinchRef,
  TransformComponent,
  TransformWrapper,
} from 'react-zoom-pan-pinch'
import {
  useWindowSize,
  useLocalStorage,
  useKey,
  useKeyPressEvent,
} from 'react-use'
import inpaint from './adapters/inpainting'
import Button from './components/Button'
import Slider from './components/Slider'
import SizeSelector from './components/SizeSelector'
import { downloadImage, loadImage, useImage } from './utils'

const TOOLBAR_SIZE = 200
const BRUSH_COLOR = 'rgba(189, 255, 1, 0.75)'
// const NO_COLOR = 'rgba(255,255,255,0)'

interface EditorProps {
  file: File
}

interface Line {
  size?: number
  pts: { x: number; y: number }[]
}

function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: Line[],
  color = BRUSH_COLOR
) {
  ctx.strokeStyle = color
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  lines.forEach(line => {
    if (!line?.pts.length || !line.size) {
      return
    }
    ctx.lineWidth = line.size
    ctx.beginPath()
    ctx.moveTo(line.pts[0].x, line.pts[0].y)
    line.pts.forEach(pt => ctx.lineTo(pt.x, pt.y))
    ctx.stroke()
  })
}

export default function Editor(props: EditorProps) {
  const { file } = props
  const [brushSize, setBrushSize] = useState(40)
  const [original, isOriginalLoaded] = useImage(file)
  const [renders, setRenders] = useState<HTMLImageElement[]>([])
  const [context, setContext] = useState<CanvasRenderingContext2D>()
  const [maskCanvas] = useState<HTMLCanvasElement>(() => {
    return document.createElement('canvas')
  })
  const [lines, setLines] = useState<Line[]>([{ pts: [] }])
  const [lines4Show, setLines4Show] = useState<Line[]>([{ pts: [] }])
  const [historyLineCount, setHistoryLineCount] = useState<number[]>([])
  const [{ x, y }, setCoords] = useState({ x: -1, y: -1 })
  const [showBrush, setShowBrush] = useState(false)
  const [isPanning, setIsPanning] = useState<boolean>(false)
  const [showOriginal, setShowOriginal] = useState(false)
  const [isInpaintingLoading, setIsInpaintingLoading] = useState(false)
  const [showSeparator, setShowSeparator] = useState(false)
  const [scale, setScale] = useState<number>(1)
  const [minScale, setMinScale] = useState<number>()
  // ['1080', '2000', 'Original']
  const [sizeLimit, setSizeLimit] = useLocalStorage('sizeLimit', '1080')
  const windowSize = useWindowSize()
  const viewportRef = useRef<ReactZoomPanPinchRef | undefined | null>()

  const [isDraging, setIsDraging] = useState(false)
  const [isMultiStrokeKeyPressed, setIsMultiStrokeKeyPressed] = useState(false)

  const draw = useCallback(() => {
    if (!context) {
      return
    }
    context.clearRect(0, 0, context.canvas.width, context.canvas.height)
    const currRender = renders[renders.length - 1]
    if (currRender?.src) {
      context.drawImage(
        currRender,
        0,
        0,
        original.naturalWidth,
        original.naturalHeight
      )
    } else {
      context.drawImage(original, 0, 0)
    }
    drawLines(context, lines4Show)
  }, [context, lines4Show, original, renders])

  const refreshCanvasMask = useCallback(() => {
    if (!context?.canvas.width || !context?.canvas.height) {
      throw new Error('canvas has invalid size')
    }
    maskCanvas.width = context?.canvas.width
    maskCanvas.height = context?.canvas.height
    const ctx = maskCanvas.getContext('2d')
    if (!ctx) {
      throw new Error('could not retrieve mask canvas')
    }

    drawLines(ctx, lines, 'white')
  }, [context?.canvas.height, context?.canvas.width, lines, maskCanvas])

  const runInpainting = useCallback(async () => {
    setIsInpaintingLoading(true)
    refreshCanvasMask()
    try {
      const res = await inpaint(file, maskCanvas.toDataURL(), sizeLimit)
      if (!res) {
        throw new Error('empty response')
      }
      // TODO: fix the render if it failed loading
      const newRender = new Image()
      await loadImage(newRender, res)
      renders.push(newRender)
      lines.push({ pts: [] } as Line)
      setRenders([...renders])
      setLines([...lines])

      historyLineCount.push(lines4Show.length)
      setHistoryLineCount(historyLineCount)
      lines4Show.length = 0
      setLines4Show([{ pts: [] } as Line])
    } catch (e: any) {
      // eslint-disable-next-line
      alert(e.message ? e.message : e.toString())
    }
    setIsInpaintingLoading(false)
    draw()
  }, [
    draw,
    file,
    lines,
    lines4Show,
    maskCanvas,
    refreshCanvasMask,
    renders,
    sizeLimit,
    historyLineCount,
  ])

  const hadDrawSomething = () => {
    return lines4Show.length !== 0 && lines4Show[0].pts.length !== 0
  }

  const hadRunInpainting = () => {
    return renders.length !== 0
  }

  const clearDrawing = () => {
    setIsDraging(false)
    lines4Show.length = 0
    setLines4Show([{ pts: [] } as Line])
  }

  const handleMultiStrokeKeyDown = () => {
    if (isInpaintingLoading) {
      return
    }
    setIsMultiStrokeKeyPressed(true)
  }

  const handleMultiStrokeKeyup = () => {
    if (!isMultiStrokeKeyPressed) {
      return
    }
    if (isInpaintingLoading) {
      return
    }

    setIsMultiStrokeKeyPressed(false)
    if (hadDrawSomething()) {
      runInpainting()
    }
  }

  const predicate = (event: KeyboardEvent) => {
    return event.key === 'Control' || event.key === 'Meta'
  }

  useKey(predicate, handleMultiStrokeKeyup, { event: 'keyup' }, [
    isInpaintingLoading,
    isMultiStrokeKeyPressed,
    hadDrawSomething,
  ])

  useKey(
    predicate,
    handleMultiStrokeKeyDown,
    {
      event: 'keydown',
    },
    [isInpaintingLoading]
  )

  // Draw once the original image is loaded
  useEffect(() => {
    if (!original) {
      return
    }

    if (isOriginalLoaded) {
      const rW = windowSize.width / original.naturalWidth
      const rH = (windowSize.height - TOOLBAR_SIZE) / original.naturalHeight
      if (rW < 1 || rH < 1) {
        const s = Math.min(rW, rH)
        setMinScale(s)
        setScale(s)
      } else {
        setMinScale(1)
      }

      if (context?.canvas) {
        context.canvas.width = original.naturalWidth
        context.canvas.height = original.naturalHeight
      }
      draw()
    }
  }, [context?.canvas, draw, original, isOriginalLoaded, windowSize])

  // Zoom reset
  const resetZoom = useCallback(() => {
    if (!minScale || !original || !windowSize) {
      return
    }
    const viewport = viewportRef.current
    if (!viewport) {
      throw new Error('no viewport')
    }
    const offsetX = (windowSize.width - original.width * minScale) / 2
    const offsetY = (windowSize.height - original.height * minScale) / 2
    viewport.setTransform(offsetX, offsetY, minScale, 200, 'easeOutQuad')
    viewport.state.scale = minScale
    setScale(minScale)
  }, [viewportRef, minScale, original, windowSize])

  const handleEscPressed = () => {
    if (isInpaintingLoading) {
      return
    }
    if (isDraging || isMultiStrokeKeyPressed) {
      clearDrawing()
    } else {
      resetZoom()
    }
  }

  useKey(
    'Escape',
    handleEscPressed,
    {
      event: 'keydown',
    },
    [
      isDraging,
      isInpaintingLoading,
      isMultiStrokeKeyPressed,
      resetZoom,
      clearDrawing,
    ]
  )

  const onPaint = (px: number, py: number) => {
    const currShowLine = lines4Show[lines4Show.length - 1]
    currShowLine.pts.push({ x: px, y: py })

    const currLine = lines[lines.length - 1]
    currLine.pts.push({ x: px, y: py })

    draw()
  }

  const onMouseMove = (ev: SyntheticEvent) => {
    const mouseEvent = ev.nativeEvent as MouseEvent
    setCoords({ x: mouseEvent.pageX, y: mouseEvent.pageY })
  }

  const onMouseDrag = (ev: SyntheticEvent) => {
    if (isPanning) {
      return
    }
    if (!isDraging) {
      return
    }
    const mouseEvent = ev.nativeEvent as MouseEvent
    const px = mouseEvent.offsetX
    const py = mouseEvent.offsetY
    onPaint(px, py)
  }

  const onPointerUp = () => {
    if (isPanning) {
      return
    }
    if (!original.src) {
      return
    }
    const canvas = context?.canvas
    if (!canvas) {
      return
    }
    if (isInpaintingLoading) {
      return
    }
    if (!isDraging) {
      return
    }
    setIsDraging(false)
    if (isMultiStrokeKeyPressed) {
      lines.push({ pts: [] } as Line)
      setLines([...lines])

      lines4Show.push({ pts: [] } as Line)
      setLines4Show([...lines4Show])
      return
    }

    if (lines4Show.length !== 0 && lines4Show[0].pts.length !== 0) {
      runInpainting()
    }
  }

  const onMouseDown = (ev: SyntheticEvent) => {
    if (isPanning) {
      return
    }
    if (!original.src) {
      return
    }
    const canvas = context?.canvas
    if (!canvas) {
      return
    }
    if (isInpaintingLoading) {
      return
    }
    setIsDraging(true)
    const currLine4Show = lines4Show[lines4Show.length - 1]
    currLine4Show.size = brushSize
    const currLine = lines[lines.length - 1]
    currLine.size = brushSize

    const mouseEvent = ev.nativeEvent as MouseEvent
    onPaint(mouseEvent.offsetX, mouseEvent.offsetY)
  }

  const undo = () => {
    if (!renders.length) {
      return
    }
    if (!historyLineCount.length) {
      return
    }

    const l = lines
    const count = historyLineCount[historyLineCount.length - 1]
    for (let i = 0; i <= count; i += 1) {
      l.pop()
    }

    setLines([...l, { pts: [] }])
    historyLineCount.pop()
    setHistoryLineCount(historyLineCount)

    const r = renders
    r.pop()
    setRenders([...r])
  }

  // Handle Cmd+Z
  const undoPredicate = (event: KeyboardEvent) => {
    const isCmdZ = (event.metaKey || event.ctrlKey) && event.key === 'z'
    // Handle tab switch
    if (event.key === 'Tab') {
      event.preventDefault()
    }
    if (isCmdZ) {
      event.preventDefault()
      return true
    }
    return false
  }

  useKey(undoPredicate, undo)

  useKeyPressEvent(
    'Tab',
    ev => {
      ev?.preventDefault()
      ev?.stopPropagation()
      if (hadRunInpainting()) {
        setShowSeparator(true)
        setShowOriginal(true)
      }
    },
    ev => {
      ev?.preventDefault()
      ev?.stopPropagation()
      if (hadRunInpainting()) {
        setShowOriginal(false)
        setTimeout(() => setShowSeparator(false), 300)
      }
    }
  )

  function download() {
    const name = file.name.replace(/(\.[\w\d_-]+)$/i, '_cleanup$1')
    const currRender = renders[renders.length - 1]
    downloadImage(currRender.currentSrc, name)
  }

  const onSizeLimitChange = (_sizeLimit: string) => {
    setSizeLimit(_sizeLimit)
  }

  const toggleShowBrush = (newState: boolean) => {
    if (newState !== showBrush && !isPanning) {
      setShowBrush(newState)
    }
  }

  const getCursor = useCallback(() => {
    if (isPanning) {
      return 'grab'
    }
    if (showBrush) {
      return 'none'
    }
    return undefined
  }, [showBrush, isPanning])

  // Standard Hotkeys for Brush Size
  useKeyPressEvent('[', () => {
    setBrushSize(currentBrushSize => {
      if (currentBrushSize > 10) {
        return currentBrushSize - 10
      }
      if (currentBrushSize <= 10 && currentBrushSize > 0) {
        return currentBrushSize - 5
      }
      return currentBrushSize
    })
  })

  useKeyPressEvent(']', () => {
    setBrushSize(currentBrushSize => {
      return currentBrushSize + 10
    })
  })

  // Toggle clean/zoom tool on spacebar.
  useKeyPressEvent(
    ' ',
    ev => {
      ev?.preventDefault()
      ev?.stopPropagation()
      setShowBrush(false)
      setIsPanning(true)
    },
    ev => {
      ev?.preventDefault()
      ev?.stopPropagation()
      setShowBrush(true)
      setIsPanning(false)
    }
  )

  const getCurScale = (): number => {
    let s = minScale
    if (viewportRef.current?.state.scale !== undefined) {
      s = viewportRef.current?.state.scale
    }
    return s!
  }

  const getBrushStyle = () => {
    const curScale = getCurScale()
    return {
      width: `${brushSize * curScale}px`,
      height: `${brushSize * curScale}px`,
      left: `${x}px`,
      top: `${y}px`,
      transform: 'translate(-50%, -50%)',
    }
  }

  if (!original || !scale || !minScale) {
    return <></>
  }

  return (
    <div
      className="flex flex-col items-center"
      style={{
        height: '100%',
        width: '100%',
      }}
      aria-hidden="true"
      onMouseMove={onMouseMove}
      onMouseUp={onPointerUp}
    >
      <TransformWrapper
        ref={r => {
          if (r) {
            viewportRef.current = r
          }
        }}
        panning={{ disabled: !isPanning, velocityDisabled: true }}
        wheel={{ step: 0.05 }}
        centerZoomedOut
        alignmentAnimation={{ disabled: true }}
        centerOnInit
        limitToBounds={false}
        doubleClick={{ disabled: true }}
        initialScale={minScale}
        minScale={minScale}
        onZoom={ref => {
          setScale(ref.state.scale)
        }}
      >
        <TransformComponent
          wrapperStyle={{
            width: '100%',
            height: '100%',
          }}
          contentClass={
            isInpaintingLoading
              ? 'animate-pulse-fast pointer-events-none transition-opacity'
              : ''
          }
        >
          <>
            <canvas
              className="rounded-sm"
              style={{ cursor: getCursor() }}
              onContextMenu={e => {
                e.preventDefault()
              }}
              onMouseOver={() => toggleShowBrush(true)}
              onFocus={() => toggleShowBrush(true)}
              onMouseLeave={() => toggleShowBrush(false)}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseDrag}
              ref={r => {
                if (r && !context) {
                  const ctx = r.getContext('2d')
                  if (ctx) {
                    setContext(ctx)
                  }
                }
              }}
            />
            <div
              className={[
                'absolute top-0 right-0 pointer-events-none',
                'overflow-hidden',
                'border-primary',
                showSeparator ? 'border-l-4' : '',
              ].join(' ')}
              style={{
                width: showOriginal
                  ? `${Math.round(original.naturalWidth)}px`
                  : '0px',
                height: original.naturalHeight,
                transitionProperty: 'width, height',
                transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
                transitionDuration: '300ms',
              }}
            >
              <img
                className="absolute right-0"
                src={original.src}
                alt="original"
                width={`${original.naturalWidth}px`}
                height={`${original.naturalHeight}px`}
                style={{
                  width: `${original.naturalWidth}px`,
                  height: `${original.naturalHeight}px`,
                  maxWidth: 'none',
                }}
              />
            </div>
          </>
        </TransformComponent>
      </TransformWrapper>

      {showBrush && !isInpaintingLoading && !isPanning && (
        <div
          className="hidden sm:block absolute rounded-full border border-primary bg-primary bg-opacity-80 pointer-events-none"
          style={getBrushStyle()}
        />
      )}

      <div
        className="fixed w-full bottom-0 flex items-center justify-center"
        style={{ height: '90px' }}
      >
        <div
          className={[
            'flex items-center justify-center space-x-6',
            '',
            // 'bg-black backdrop-blur backdrop-filter bg-opacity-10',
          ].join(' ')}
        >
          <SizeSelector
            value={sizeLimit || '1080'}
            onChange={onSizeLimitChange}
            originalWidth={original.naturalWidth}
            originalHeight={original.naturalHeight}
          />
          <Slider
            label={
              <span>
                <span className="hidden md:inline">Brush</span>
              </span>
            }
            min={10}
            max={150}
            value={brushSize}
            onChange={setBrushSize}
          />
          <div>
            <Button
              className="mr-2"
              icon={<ArrowsExpandIcon className="w-6 h-6" />}
              disabled={scale === minScale}
              onClick={resetZoom}
            />
            <Button
              className="mr-2"
              icon={
                <svg
                  width="19"
                  height="9"
                  viewBox="0 0 19 9"
                  fill="none"
                  xmlns="http://www.w3.org/2000/svg"
                  className="w-6 h-6"
                >
                  <path
                    d="M2 1C2 0.447715 1.55228 0 1 0C0.447715 0 0 0.447715 0 1H2ZM1 8H0V9H1V8ZM8 9C8.55228 9 9 8.55229 9 8C9 7.44771 8.55228 7 8 7V9ZM16.5963 7.42809C16.8327 7.92721 17.429 8.14016 17.9281 7.90374C18.4272 7.66731 18.6402 7.07103 18.4037 6.57191L16.5963 7.42809ZM16.9468 5.83205L17.8505 5.40396L16.9468 5.83205ZM0 1V8H2V1H0ZM1 9H8V7H1V9ZM1.66896 8.74329L6.66896 4.24329L5.33104 2.75671L0.331035 7.25671L1.66896 8.74329ZM16.043 6.26014L16.5963 7.42809L18.4037 6.57191L17.8505 5.40396L16.043 6.26014ZM6.65079 4.25926C9.67554 1.66661 14.3376 2.65979 16.043 6.26014L17.8505 5.40396C15.5805 0.61182 9.37523 -0.710131 5.34921 2.74074L6.65079 4.25926Z"
                    fill="currentColor"
                  />
                </svg>
              }
              onClick={undo}
              disabled={renders.length === 0}
            />
            <Button
              className="mr-2"
              icon={<EyeIcon className="w-6 h-6" />}
              onDown={ev => {
                ev.preventDefault()
                setShowSeparator(true)
                setShowOriginal(true)
              }}
              onUp={() => {
                setShowOriginal(false)
                setTimeout(() => setShowSeparator(false), 300)
              }}
              disabled={renders.length === 0}
            >
              {undefined}
            </Button>

            <Button
              icon={<DownloadIcon className="w-6 h-6" />}
              disabled={!renders.length}
              onClick={download}
            >
              {undefined}
            </Button>
          </div>

          <div
            className="absolute bg-black backdrop-blur backdrop-filter bg-opacity-10 rounded-xl"
            style={{
              height: '58px',
              width: '600px',
              zIndex: -1,
              marginLeft: '-1px',
            }}
          >
            {undefined}
          </div>
        </div>
      </div>
    </div>
  )
}

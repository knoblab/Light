import React, { useRef, useEffect, useCallback } from 'react';

interface WebGLTileCanvasProps {
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  zoom: number;
  pan: { x: number; y: number };
  beforeImageSrc: string | null;
  afterImageSrc: string | null;
  comparisonMode: 'original' | 'healed' | 'split';
  splitPosition: number; // 0.0 to 1.0
  isHoldComparing: boolean;
  showPixelGrid?: boolean;
  className?: string;
}

const VS_SOURCE = `#version 300 es
in vec2 a_position;
out vec2 v_texCoord;

uniform vec2 u_resolution;
uniform vec2 u_imageSize;
uniform vec2 u_pan;
uniform float u_zoom;

void main() {
  // Convert clip space (-1 to 1) to screen pixels (0 to width/height)
  vec2 screenPos = (a_position * 0.5 + 0.5) * u_resolution;

  // Calculate centered base scale
  float scaleX = u_resolution.x / u_imageSize.x;
  float scaleY = u_resolution.y / u_imageSize.y;
  float fitScale = min(scaleX, scaleY);
  vec2 fittedSize = u_imageSize * fitScale;

  vec2 center = u_resolution * 0.5;
  vec2 imgTopLeft = center - (fittedSize * u_zoom) * 0.5 + u_pan;

  // Relative coordinate inside image
  vec2 rel = (screenPos - imgTopLeft) / (fittedSize * u_zoom);
  // Invert Y for standard texture coordinates
  v_texCoord = vec2(rel.x, 1.0 - rel.y);

  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const FS_SOURCE = `#version 300 es
precision highp float;

in vec2 v_texCoord;
out vec4 outColor;

uniform sampler2D u_texBefore;
uniform sampler2D u_texAfter;
uniform bool u_hasBefore;
uniform bool u_hasAfter;
uniform int u_mode; // 0: original, 1: healed, 2: split
uniform float u_splitPos;
uniform bool u_isHoldComparing;
uniform float u_zoom;
uniform vec2 u_imageSize;
uniform bool u_showGrid;

void main() {
  // Check bounds
  if (v_texCoord.x < 0.0 || v_texCoord.x > 1.0 || v_texCoord.y < 0.0 || v_texCoord.y > 1.0) {
    outColor = vec4(0.08, 0.09, 0.11, 1.0); // Dark neutral matte
    return;
  }

  vec4 colBefore = u_hasBefore ? texture(u_texBefore, v_texCoord) : vec4(0.0, 0.0, 0.0, 1.0);
  vec4 colAfter = u_hasAfter ? texture(u_texAfter, v_texCoord) : colBefore;

  vec4 finalCol;
  if (u_isHoldComparing) {
    finalCol = colBefore;
  } else if (u_mode == 0) { // original
    finalCol = colBefore;
  } else if (u_mode == 1) { // healed
    finalCol = colAfter;
  } else { // split
    float splitX = u_splitPos;
    if (abs(v_texCoord.x - splitX) < 0.0015) {
      // Split separator line
      finalCol = vec4(1.0, 1.0, 1.0, 1.0);
    } else if (v_texCoord.x < splitX) {
      finalCol = colBefore;
    } else {
      finalCol = colAfter;
    }
  }

  // Pixel grid overlay at >= 400% zoom
  if (u_showGrid && u_zoom >= 4.0) {
    vec2 pixelCoord = v_texCoord * u_imageSize;
    vec2 gridFract = abs(fract(pixelCoord - 0.5) - 0.5);
    vec2 gridDelta = fwidth(pixelCoord);
    vec2 gridLine = smoothstep(gridDelta * 0.8, vec2(0.0), gridFract);
    float gridAlpha = max(gridLine.x, gridLine.y) * 0.25;
    finalCol = mix(finalCol, vec4(1.0, 1.0, 1.0, 1.0), gridAlpha);
  }

  outColor = finalCol;
}
`;

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.error('Shader compile error:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function createProgram(gl: WebGL2RenderingContext, vsSource: string, fsSource: string): WebGLProgram | null {
  const vs = createShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;

  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('Program link error:', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

export const WebGLTileCanvas: React.FC<WebGLTileCanvasProps> = ({
  width,
  height,
  imageWidth,
  imageHeight,
  zoom,
  pan,
  beforeImageSrc,
  afterImageSrc,
  comparisonMode,
  splitPosition,
  isHoldComparing,
  showPixelGrid = true,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glRef = useRef<WebGL2RenderingContext | null>(null);
  const progRef = useRef<WebGLProgram | null>(null);
  const texBeforeRef = useRef<WebGLTexture | null>(null);
  const texAfterRef = useRef<WebGLTexture | null>(null);
  const vaoRef = useRef<WebGLVertexArrayObject | null>(null);

  const beforeImgRef = useRef<HTMLImageElement | null>(null);
  const afterImgRef = useRef<HTMLImageElement | null>(null);

  // Initialize WebGL2
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) {
      console.warn('WebGL 2.0 unavailable; falling back to 2D.');
      return;
    }
    glRef.current = gl;

    const prog = createProgram(gl, VS_SOURCE, FS_SOURCE);
    if (!prog) return;
    progRef.current = prog;

    // Full quad setup
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    vaoRef.current = vao;

    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
      ]),
      gl.STATIC_DRAW
    );

    const posLoc = gl.getAttribLocation(prog, 'a_position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    // Textures
    const createEmptyTex = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    };

    texBeforeRef.current = createEmptyTex();
    texAfterRef.current = createEmptyTex();

    return () => {
      if (prog) gl.deleteProgram(prog);
      if (vao) gl.deleteVertexArray(vao);
    };
  }, []);

  // Update textures on image change
  const updateTexture = useCallback((gl: WebGL2RenderingContext, tex: WebGLTexture | null, img: HTMLImageElement) => {
    if (!tex) return;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  }, []);

  useEffect(() => {
    if (!beforeImageSrc) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      beforeImgRef.current = img;
      const gl = glRef.current;
      if (gl) {
        updateTexture(gl, texBeforeRef.current, img);
        render();
      }
    };
    img.src = beforeImageSrc;
  }, [beforeImageSrc, updateTexture]);

  useEffect(() => {
    if (!afterImageSrc) {
      afterImgRef.current = null;
      render();
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      afterImgRef.current = img;
      const gl = glRef.current;
      if (gl) {
        updateTexture(gl, texAfterRef.current, img);
        render();
      }
    };
    img.src = afterImageSrc;
  }, [afterImageSrc, updateTexture]);

  // Render frame
  const render = useCallback(() => {
    const gl = glRef.current;
    const prog = progRef.current;
    if (!gl || !prog) return;

    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0.08, 0.09, 0.11, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(prog);
    gl.bindVertexArray(vaoRef.current);

    // Uniforms
    gl.uniform2f(gl.getUniformLocation(prog, 'u_resolution'), gl.canvas.width, gl.canvas.height);
    gl.uniform2f(gl.getUniformLocation(prog, 'u_imageSize'), Math.max(1, imageWidth), Math.max(1, imageHeight));
    gl.uniform2f(gl.getUniformLocation(prog, 'u_pan'), pan.x, pan.y);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_zoom'), zoom);

    const modeInt = comparisonMode === 'original' ? 0 : comparisonMode === 'healed' ? 1 : 2;
    gl.uniform1i(gl.getUniformLocation(prog, 'u_mode'), modeInt);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_splitPos'), splitPosition);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_isHoldComparing'), isHoldComparing ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_showGrid'), showPixelGrid ? 1 : 0);

    // Bind texture 0: Before
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texBeforeRef.current);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_texBefore'), 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_hasBefore'), beforeImgRef.current ? 1 : 0);

    // Bind texture 1: After
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texAfterRef.current);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_texAfter'), 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_hasAfter'), afterImgRef.current ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }, [
    imageWidth,
    imageHeight,
    pan.x,
    pan.y,
    zoom,
    comparisonMode,
    splitPosition,
    isHoldComparing,
    showPixelGrid,
  ]);

  useEffect(() => {
    render();
  }, [render]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className={`block w-full h-full ${className}`}
    />
  );
};

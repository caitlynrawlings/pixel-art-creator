import React, { useState, useRef, useEffect, useCallback } from "react";
import { BlockMath } from "react-katex";
import "katex/dist/katex.min.css";
import katex from "katex";
import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import { kmeans } from "ml-kmeans";

function reduceColorsKMeans(imageData, nColors) {
  const pixels = [];
  for (let i = 0; i < imageData.data.length; i += 4) {
    pixels.push([imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]]);
  }
  const result = kmeans(pixels, nColors, {});
  const centers = result.centroids.map(c => {
    const vals = Array.isArray(c) ? c : c.centroid;
    return vals.map(v => Math.round(v));
  });
  const labels = result.clusters;
  const reduced = [];
  for (let i = 0; i < labels.length; i++) {
    const [r, g, b] = centers[labels[i]];
    reduced.push(r, g, b, 255);
  }
  return new ImageData(new Uint8ClampedArray(reduced), imageData.width, imageData.height);
}

const getColor = (r, g, b) =>
  `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;

// Render a LaTeX string to a PNG base64 string via an offscreen canvas
async function latexToPngBase64(latexStr, widthPx, heightPx) {
  return new Promise((resolve, reject) => {
    try {
      // Render KaTeX to SVG string
      const svgStr = katex.renderToString(latexStr, {
        throwOnError: false,
        output: "svg",
        displayMode: true,
      });

      // Wrap in a full SVG with explicit dimensions
      const parser = new DOMParser();
      const svgDoc = parser.parseFromString(svgStr, "image/svg+xml");
      const svgEl = svgDoc.querySelector("svg");
      svgEl.setAttribute("width", widthPx);
      svgEl.setAttribute("height", heightPx);
      // White background rect
      const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      bg.setAttribute("width", "100%");
      bg.setAttribute("height", "100%");
      bg.setAttribute("fill", "white");
      svgEl.insertBefore(bg, svgEl.firstChild);

      const serialized = new XMLSerializer().serializeToString(svgEl);
      const blob = new Blob([serialized], { type: "image/svg+xml" });
      const url = URL.createObjectURL(blob);

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = widthPx;
        canvas.height = heightPx;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, widthPx, heightPx);
        ctx.drawImage(img, 0, 0, widthPx, heightPx);
        URL.revokeObjectURL(url);
        // Return base64 WITHOUT the data:image/png;base64, prefix
        resolve(canvas.toDataURL("image/png").split(",")[1]);
      };
      img.onerror = reject;
      img.src = url;
    } catch (e) {
      reject(e);
    }
  });
}

export default function App() {
  const [image, setImage] = useState(null);
  const [gridSize, setGridSize] = useState(30);
  const [numColors, setNumColors] = useState(10);
  const [qa, setQa] = useState([{ q: "", a: "" }]);
  const previewCanvasRef = useRef(null);
  const previewTimeoutRef = useRef(null);

  const handleUpload = (e) => {
    const file = e.target.files[0];
    if (file) setImage(file);
  };

  const updateQA = (i, field, value) => {
    const copy = [...qa];
    copy[i][field] = value;
    setQa(copy);
  };

  const addQA = () => setQa([...qa, { q: "", a: "" }]);
  const removeQA = (i) => setQa(qa.filter((_, idx) => idx !== i));

  // Redraw the preview canvas whenever image/gridSize/numColors changes
  const drawPreview = useCallback(async () => {
    if (!image || !previewCanvasRef.current) return;

    const canvas = previewCanvasRef.current;
    const ctx = canvas.getContext("2d");

    const img = document.createElement("img");
    img.src = URL.createObjectURL(image);
    await new Promise((res) => (img.onload = res));

    // Offscreen canvas at grid resolution
    const off = document.createElement("canvas");
    off.width = gridSize;
    off.height = gridSize;
    const offCtx = off.getContext("2d");
    offCtx.drawImage(img, 0, 0, gridSize, gridSize);

    let imageData = offCtx.getImageData(0, 0, gridSize, gridSize);
    imageData = reduceColorsKMeans(imageData, Math.max(numColors, qa.length));

    // Draw pixelated result onto the visible preview canvas
    const PREVIEW_SIZE = 300;
    canvas.width = PREVIEW_SIZE;
    canvas.height = PREVIEW_SIZE;
    const cellW = PREVIEW_SIZE / gridSize;
    const cellH = PREVIEW_SIZE / gridSize;

    ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const idx = (y * gridSize + x) * 4;
        const r = imageData.data[idx];
        const g = imageData.data[idx + 1];
        const b = imageData.data[idx + 2];
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(Math.floor(x * cellW), Math.floor(y * cellH), Math.ceil(cellW), Math.ceil(cellH));
      }
    }

    URL.revokeObjectURL(img.src);
  }, [image, gridSize, numColors, qa.length]);

  // Debounce preview redraws so sliders don't hammer KMeans
  useEffect(() => {
    if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
    previewTimeoutRef.current = setTimeout(drawPreview, 300);
    return () => clearTimeout(previewTimeoutRef.current);
  }, [drawPreview]);

  const generateExcel = async () => {
    if (!image) {
      alert("Please upload an image before exporting.");
      return;
    }

    const effectiveColors = Math.max(numColors, qa.length);

    if (qa.length > numColors) {
      const proceed = window.confirm(
        `You have ${qa.length} questions but only ${numColors} colors.\n\n` +
        `Colors will be increased to ${qa.length}.\n\nContinue?`
      );
      if (!proceed) return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Puzzle");

    // Load + process image
    const img = document.createElement("img");
    img.src = URL.createObjectURL(image);
    await new Promise((res) => (img.onload = res));

    const canvas = document.createElement("canvas");
    canvas.width = gridSize;
    canvas.height = gridSize;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, gridSize, gridSize);

    let imageData = ctx.getImageData(0, 0, gridSize, gridSize);
    imageData = reduceColorsKMeans(imageData, effectiveColors);
    const data = imageData.data;

    // Build color map
    const colorMap = {};
    let colorIndex = 0;
    const grid = [];
    for (let y = 0; y < gridSize; y++) {
      const row = [];
      for (let x = 0; x < gridSize; x++) {
        const i = (y * gridSize + x) * 4;
        const color = getColor(data[i], data[i + 1], data[i + 2]);
        if (!(color in colorMap)) colorMap[color] = colorIndex++;
        row.push(colorMap[color]);
      }
      grid.push(row);
    }

    // Column sizing
    for (let i = 0; i < gridSize + 2; i++) {
      sheet.getColumn(i + 3).width = (300 / gridSize) / 6;
    }
    sheet.getColumn(1).width = 40;
    sheet.getColumn(2).width = 20;

    const cellHeightPt = 300 / gridSize;
    const cellsToMerge = Math.max(1, Math.round(30 / cellHeightPt));
    const totalQARows = qa.length * cellsToMerge;

    // Row sizing
    for (let i = 0; i < totalQARows + gridSize + 2; i++) {
      sheet.getRow(i + 3).height = cellHeightPt;
    }

    // Header
    sheet.mergeCells(1, 1, 1, gridSize + 2);
    sheet.getCell(1, 1).value = "Instructions: For each question, type your answer in column B. When correct, part of the image will reveal itself!";
    sheet.getCell(1, 1).font = { bold: true, size: 12 };
    sheet.getCell(1, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDDDDD" } };

    // Cell pixel dimensions for image sizing
    // Excel column width units ≈ 7px per unit; row height in pts ≈ 1.33px per pt
    const colWidthUnits = (300 / gridSize) / 6;
    const imgWidthPx = Math.max(80, Math.round(colWidthUnits * 7 * 1));
    const imgHeightPx = Math.max(30, Math.round(cellHeightPt * cellsToMerge * 1.33));
    // Use a fixed comfortable cell width for the question column
    const qImgWidth = Math.round(sheet.getColumn(1).width * 7);
    const qImgHeight = imgHeightPx;

    // Questions loop — embed LaTeX as images
    for (let i = 0; i < qa.length; i++) {
      const item = qa[i];
      const startRow = 3 + i * cellsToMerge;
      const endRow = startRow + cellsToMerge - 1;

      sheet.mergeCells(startRow, 1, endRow, 1);
      sheet.mergeCells(startRow, 2, endRow, 2);

      // Embed LaTeX image into question cell
      if (item.q.trim()) {
        try {
          const pngBase64 = await latexToPngBase64(item.q, Math.max(200, qImgWidth), Math.max(40, qImgHeight));
          const imgId = workbook.addImage({ base64: pngBase64, extension: "png" });
          // tl/br in zero-indexed col/row
          sheet.addImage(imgId, {
            tl: { col: 0, row: startRow - 1 },
            br: { col: 1, row: endRow },
            editAs: "oneCell",
          });
        } catch {
          // Fallback to plain text if KaTeX fails
          sheet.getCell(startRow, 1).value = item.q;
        }
      }

      // Answer cell — force text format
      const answerCell = sheet.getCell(startRow, 2);
      answerCell.value = null;
      answerCell.numFmt = "@";
      answerCell.alignment = { vertical: "middle", horizontal: "center" };

      // Green if correct
      sheet.addConditionalFormatting({
        ref: `B${startRow}`,
        rules: [
          {
            type: "expression",
            priority: 1,
            formulae: [`EXACT(B${startRow},"${item.a}")`],
            style: {
              fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF97FF87" }, bgColor: { argb: "FF97FF87" }  },
            },
          },
          // Red if something typed but wrong
          {
            type: "expression",
            priority: 2,
            formulae: [`AND(LEN(B${startRow})>0,NOT(EXACT(B${startRow},"${item.a}")))`],
            style: {
              fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF8787" }, bgColor: { argb: "FFFF8787" } },
            },
          },
        ],
      });
    }

    // Grid loop
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const rowNum = y + 3;
        const colNum = x + 3;
        const cell = sheet.getCell(rowNum, colNum);
        const colorId = grid[y][x];
        const colorKey = Object.keys(colorMap).find(k => colorMap[k] === colorId);
        const cleanHex = colorKey.replace("#", "").toUpperCase();
        const excelColor = "FF" + cleanHex;

        cell.value = "";
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };

        // if (colorId < qa.length) {
          const answerRow = 3 + (colorId % qa.length) * cellsToMerge;
          const expected = qa[colorId % qa.length].a;

          sheet.addConditionalFormatting({
            ref: cell.address,
            rules: [
              {
                type: "expression",
                priority: 1,
                formulae: [`EXACT($B$${answerRow},"${expected}")`],
                style: {
                  fill: {
                    type: "pattern",
                    pattern: "solid",
                    fgColor: { argb: excelColor },
                    bgColor: { argb: excelColor },
                  },
                },
              },
            ],
          });
        // }
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    saveAs(new Blob([buffer]), "puzzle.xlsx");
  };

  return (
    <div style={{ fontFamily: "'Courier New', monospace", background: "#0f0f0f", minHeight: "100vh", color: "#e8e8e8", padding: "2rem" }}>
      <h1 style={{ fontSize: "1.8rem", fontWeight: 700, letterSpacing: "0.05em", marginBottom: "2rem", color: "#f0e040" }}>
        Pixel Art Activity Generator
      </h1>

      {/* Upload */}
      <section style={{ marginBottom: "2rem" }}>
        <label style={{ display: "block", fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#888", marginBottom: "0.5rem" }}>
          Image
        </label>
        <input type="file" accept="image/*" onChange={handleUpload}
          style={{ background: "#1e1e1e", border: "1px solid #333", color: "#e8e8e8", padding: "0.5rem 0.75rem", borderRadius: "4px", cursor: "pointer" }} />
      </section>

      {/* Sliders + Preview side by side */}
      <section style={{ display: "flex", gap: "2rem", marginBottom: "2rem", flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 280px" }}>
          <div style={{ marginBottom: "1.5rem" }}>
            <label style={{ display: "block", fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#888", marginBottom: "0.5rem" }}>
              Grid Resolution: <span style={{ color: "#f0e040" }}>{gridSize} × {gridSize}</span>
            </label>
            <input type="range" min="10" max="80" value={gridSize}
              onChange={(e) => setGridSize(Number(e.target.value))}
              style={{ width: "100%", accentColor: "#f0e040" }} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#888", marginBottom: "0.5rem" }}>
              Number of Colors: <span style={{ color: "#f0e040" }}>{numColors}</span>
            </label>
            <input type="range" min="2" max="80" value={numColors}
              onChange={(e) => setNumColors(Number(e.target.value))}
              style={{ width: "100%", accentColor: "#f0e040" }} />
          </div>
          <button onClick={generateExcel}
            style={{ marginTop: "2rem", background: "#f0e040", color: "#0f0f0f", border: "none", padding: "0.75rem 2rem", borderRadius: "4px", fontWeight: 700, fontSize: "1rem", cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em" }}>
            Export to Excel
          </button>
        </div>

        {/* Preview canvas */}
        <div style={{ flex: "0 0 auto" }}>
          <label style={{ display: "block", fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#888", marginBottom: "0.5rem" }}>
            Preview
          </label>
          <canvas ref={previewCanvasRef}
            style={{ border: "1px solid #333", imageRendering: "pixelated", display: "block", background: "#1e1e1e", width: "300px", height: "300px" }} />
          {!image && (
            <p style={{ fontSize: "0.75rem", color: "#555", marginTop: "0.5rem" }}>Upload an image to preview</p>
          )}
        </div>
      </section>

      {/* Questions */}
      <section style={{ marginBottom: "2rem" }}>
        <label style={{ display: "block", fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#888", marginBottom: "1rem" }}>
          Questions
        </label>
        {qa.map((item, i) => (
          <div key={i} style={{ background: "#1e1e1e", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "1rem", marginBottom: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <span style={{ fontSize: "0.7rem", color: "#ccc", letterSpacing: "0.1em" }}>Q{i + 1} — Color {i + 1}</span>
              <button onClick={() => removeQA(i)}
                style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: "1rem" }}>✕</button>
            </div>
            <textarea
              style={{ width: "100%", background: "#111", border: "1px solid #2a2a2a", color: "#e8e8e8", padding: "0.5rem", borderRadius: "4px", fontFamily: "inherit", fontSize: "0.85rem", resize: "vertical", boxSizing: "border-box" }}
              placeholder="Question (e.g. 2+2)"
              rows={2}
              value={item.q}
              onChange={(e) => updateQA(i, "q", e.target.value)}
            />
            {/* {item.q && (
              <div style={{ marginBottom: "0.75rem", padding: "0.5rem", background: "#0a0a0a", borderRadius: "4px", overflowX: "auto" }}>
                <BlockMath math={item.q} />
              </div>
            )} */}
            <input
              style={{ width: "100%", background: "#111", border: "1px solid #2a2a2a", color: "#f0e040", padding: "0.5rem", borderRadius: "4px", fontFamily: "inherit", fontSize: "0.85rem", marginTop: "0.5rem", boxSizing: "border-box" }}
              placeholder="Answer (exact text match)"
              value={item.a}
              onChange={(e) => updateQA(i, "a", e.target.value)}
            />
          </div>
        ))}
        <button onClick={addQA}
          style={{ background: "#1e1e1e", border: "1px dashed #444", color: "#888", padding: "0.5rem 1.25rem", borderRadius: "4px", cursor: "pointer", fontSize: "0.85rem", width: "100%" }}>
          + Add Question
        </button>
      </section>

    </div>
  );
}
import React, { useState, useRef, useEffect, useCallback } from "react";
import { BlockMath } from "react-katex";
import "katex/dist/katex.min.css";
import katex from "katex";
import ExcelJS from "exceljs";
import { saveAs } from "file-saver";
import { kmeans } from "ml-kmeans";
import html2canvas from "html2canvas";
import { toPng } from "html-to-image";

async function latexToPngBase64(latex, width = 400, height = 80) {
  return new Promise((resolve, reject) => {
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      opacity: "1",           // must be visible for font rendering
      visibility: "visible",
      zIndex: "-9999",        // behind everything but still rendered
      background: "white",
      padding: "1px 10px",
      display: "inline-block",
      alignItems: "center",
      color: "black",
      fontSize: "18px",
      width: "fit-content",
      height: "fit-content",
      lineHeight: "1",
    });

    try {
      katex.render(latex, container, { throwOnError: false, displayMode: true });
    } catch (e) {
      container.innerText = latex;
    }

    const katexEl = container.querySelector(".katex-display");
    if (katexEl) {
      katexEl.style.margin = "0.1rem";
    }

    document.body.appendChild(container);

    // Wait for layout, fonts, and KaTeX's own SVG/DOM to settle
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(async () => {
      try {
        const actualWidth = container.offsetWidth;
        const actualHeight = container.offsetHeight;

        const dataUrl = await toPng(container, {
          backgroundColor: "white",
          pixelRatio: 2,
          width: actualWidth,
          height: actualHeight,
          skipAutoScale: true,
          fontEmbedCSS: "",       // skip font embedding — fonts are already rendered
          filter: (node) => {
            // Skip any <link> or <style> nodes that try to load external fonts
            if (node.tagName === "LINK") return false;
            return true;
          },
          // Provide empty fetch for anything that would trigger a cross-origin request
          fetchRequestInit: { mode: "same-origin" },
        });

        document.body.removeChild(container);
        resolve({
          base64: dataUrl.replace(/^data:image\/png;base64,/, ""),
          width: actualWidth,
          height: actualHeight
        });
        // resolve(dataUrl.replace(/^data:image\/png;base64,/, ""), actualWidth, actualHeight);
      } catch (err) {
        if (container.parentNode) document.body.removeChild(container);
        reject(err);
      }
    }, 100)));  // 100ms gives KaTeX fonts time to fully paint
  });
}


function reduceColorsKMeans(imageData, nColors) {
  const pixels = [];
  for (let i = 0; i < imageData.data.length; i += 4)
    pixels.push([imageData.data[i], imageData.data[i + 1], imageData.data[i + 2]]);
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

// ── Tooltip component ────────────────────────────────────────────────────────
function InfoTooltip({ children }) {
  const [visible, setVisible] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setVisible(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <span
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onClick={() => setVisible(v => !v)}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: "16px", height: "16px", borderRadius: "50%",
          background: "#444", color: "#aaa", fontSize: "10px", fontWeight: 700,
          cursor: "pointer", userSelect: "none", flexShrink: 0,
          border: "1px solid #666", lineHeight: 1,
        }}
      >i</span>
      {visible && (
        <span style={{
          position: "absolute", bottom: "calc(100% + 8px)", left: "50%",
          transform: "translateX(-50%)", background: "#2a2a2a",
          border: "1px solid #444", borderRadius: "6px", padding: "10px 12px",
          fontSize: "0.75rem", color: "#ccc", lineHeight: 1.6,
          width: "260px", zIndex: 100, pointerEvents: "none",
          boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
        }}>
          {children}
          <span style={{
            position: "absolute", top: "100%", left: "50%", transform: "translateX(-50%)",
            borderLeft: "6px solid transparent", borderRight: "6px solid transparent",
            borderTop: "6px solid #444",
          }} />
        </span>
      )}
    </span>
  );
}

const LATEX_INFO = (
  <>
    <strong style={{ color: "#f0e040" }}>LaTeX mode</strong> renders your question as a
    formatted math equation in the Excel file using an embedded image.<br /><br />
    <strong style={{ color: "#aaa" }}>✓ Use for:</strong> fractions, exponents, symbols
    (e.g. <code style={{ color: "#f0e040" }}>\frac{"{"}{"}"}{"{"}{"}"})</code><br /><br />
    <strong style={{ color: "#aaa" }}>✗ Plain text:</strong> faster export, simpler
    questions, no math formatting needed.
  </>
);

export default function App() {
  const [image, setImage] = useState(null);
  const [gridSize, setGridSize] = useState(30);
  const [numColors, setNumColors] = useState(10);
  const [qa, setQa] = useState([{ q: "", a: "", l: false }]);
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

  const addQA = () => setQa([...qa, { q: "", a: "", l: false }]);
  const removeQA = (i) => setQa(qa.filter((_, idx) => idx !== i));

  // ── Bulk LaTeX controls ──────────────────────────────────────────────────
  const allLatex = qa.every(q => q.l);
  const someLatex = qa.some(q => q.l);

  const setAllLatex = (val) => setQa(qa.map(q => ({ ...q, l: val })));

  // ── Preview ──────────────────────────────────────────────────────────────
  const drawPreview = useCallback(async () => {
    if (!image || !previewCanvasRef.current) return;
    const canvas = previewCanvasRef.current;
    const ctx = canvas.getContext("2d");
    const img = document.createElement("img");
    img.src = URL.createObjectURL(image);
    await new Promise((res) => (img.onload = res));
    const off = document.createElement("canvas");
    off.width = gridSize; off.height = gridSize;
    const offCtx = off.getContext("2d");
    offCtx.drawImage(img, 0, 0, gridSize, gridSize);
    let imageData = offCtx.getImageData(0, 0, gridSize, gridSize);
    imageData = reduceColorsKMeans(imageData, Math.max(numColors, qa.length));
    const PREVIEW_SIZE = 300;
    canvas.width = PREVIEW_SIZE; canvas.height = PREVIEW_SIZE;
    const cellW = PREVIEW_SIZE / gridSize;
    const cellH = PREVIEW_SIZE / gridSize;
    ctx.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const idx = (y * gridSize + x) * 4;
        ctx.fillStyle = `rgb(${imageData.data[idx]},${imageData.data[idx+1]},${imageData.data[idx+2]})`;
        ctx.fillRect(Math.floor(x * cellW), Math.floor(y * cellH), Math.ceil(cellW), Math.ceil(cellH));
      }
    }
    URL.revokeObjectURL(img.src);
  }, [image, gridSize, numColors, qa.length]);

  useEffect(() => {
    if (previewTimeoutRef.current) clearTimeout(previewTimeoutRef.current);
    previewTimeoutRef.current = setTimeout(drawPreview, 300);
    return () => clearTimeout(previewTimeoutRef.current);
  }, [drawPreview]);

  // ── Export ───────────────────────────────────────────────────────────────
  const generateExcel = async () => {
    if (!image) { alert("Please upload an image before exporting."); return; }
    const effectiveColors = Math.max(numColors, qa.length);
    if (qa.length > numColors) {
      const proceed = window.confirm(
        `You have ${qa.length} questions but only ${numColors} colors.\nColors will be increased to ${qa.length}.\nContinue?`
      );
      if (!proceed) return;
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Puzzle");

    const img = document.createElement("img");
    img.src = URL.createObjectURL(image);
    await new Promise((res) => (img.onload = res));
    const canvas = document.createElement("canvas");
    canvas.width = gridSize; canvas.height = gridSize;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, gridSize, gridSize);
    let imageData = ctx.getImageData(0, 0, gridSize, gridSize);
    imageData = reduceColorsKMeans(imageData, effectiveColors);
    const data = imageData.data;

    const colorMap = {};
    let colorIndex = 0;
    const grid = [];
    for (let y = 0; y < gridSize; y++) {
      const row = [];
      for (let x = 0; x < gridSize; x++) {
        const i = (y * gridSize + x) * 4;
        const color = getColor(data[i], data[i+1], data[i+2]);
        if (!(color in colorMap)) colorMap[color] = colorIndex++;
        row.push(colorMap[color]);
      }
      grid.push(row);
    }

    for (let i = 0; i < gridSize + 2; i++) sheet.getColumn(i + 3).width = (300 / gridSize) / 6;
    sheet.getColumn(1).width = 40;
    sheet.getColumn(2).width = 20;

    const cellHeightPt = 300 / gridSize;
    const cellsToMerge = Math.max(1, Math.round(30 / cellHeightPt));

    for (let i = 0; i < qa.length * cellsToMerge + gridSize + 2; i++)
      sheet.getRow(i + 3).height = cellHeightPt;

    sheet.mergeCells(1, 1, 1, gridSize + 2);
    const headerCell = sheet.getCell(1, 1);
    headerCell.value = "Instructions: Type your answer in column B. Correct answers reveal the image!";
    headerCell.font = { bold: true, size: 12 };
    headerCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDDDDDD" } };

    const qImgWidth = Math.round(sheet.getColumn(1).width * 7);
    const imgHeightPx = Math.round(cellHeightPt * cellsToMerge * 1.33) //Math.max(30, Math.round(cellHeightPt * cellsToMerge * 1.33));

    for (let i = 0; i < qa.length; i++) {
      const item = qa[i];
      const startRow = 3 + i * cellsToMerge;
      const endRow = startRow + cellsToMerge - 1;

      sheet.mergeCells(startRow, 1, endRow, 1);
      sheet.mergeCells(startRow, 2, endRow, 2);

      if (item.l && item.q.trim()) {
        // LaTeX mode — embed as image
        try {
          // const pngBase64 = await latexToPngBase64(item.q, Math.max(200, qImgWidth), Math.max(40, imgHeightPx));

          // const imgId = workbook.addImage({ base64: pngBase64, extension: "png" });
          // sheet.addImage(imgId, {
          //   tl: { col: 0, row: startRow - 1 },
          //   br: { col: 1, row: endRow },
          //   editAs: "oneCell",
          // });
          const img = await latexToPngBase64(item.q);

          const imgId = workbook.addImage({
            base64: img.base64,
            extension: "png",
          });

          const targetHeight = imgHeightPx * 0.85;
          const scale = targetHeight / img.height;


          sheet.addImage(imgId, {
            tl: { col: 0.2, row: startRow - 1 + 0.1 },
            ext: {
              width: img.width * scale,
              height: targetHeight
            }
          });

//sheet.getRow(startRow).height = targetHeight * 0.75;

        } catch (err) {
          console.log("error: ", err)
          sheet.getCell(startRow, 1).value = item.q;
        }
      } else {
        // Plain text mode
        const qCell = sheet.getCell(startRow, 1);
        qCell.value = item.q || "";
        qCell.numFmt = "@";
        qCell.alignment = { vertical: "middle", wrapText: true };
      }

      const answerCell = sheet.getCell(startRow, 2);
      answerCell.value = null;
      answerCell.numFmt = "@";
      answerCell.alignment = { vertical: "middle", horizontal: "center" };

      sheet.addConditionalFormatting({
        ref: `B${startRow}`,
        rules: [
          {
            type: "expression", priority: 1,
            formulae: [`EXACT(B${startRow},"${item.a}")`],
            style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF97FF87" }, bgColor: { argb: "FF97FF87" } } },
          },
          {
            type: "expression", priority: 2,
            formulae: [`AND(LEN(B${startRow})>0,NOT(EXACT(B${startRow},"${item.a}")))`],
            style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFF8787" }, bgColor: { argb: "FFFF8787" } } },
          },
        ],
      });
    }

    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        const cell = sheet.getCell(y + 3, x + 3);
        const colorId = grid[y][x];
        const colorKey = Object.keys(colorMap).find(k => colorMap[k] === colorId);
        const excelColor = "FF" + colorKey.replace("#", "").toUpperCase();
        cell.value = "";
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };
        const answerRow = 3 + (colorId % qa.length) * cellsToMerge;
        const expected = qa[colorId % qa.length].a;
        sheet.addConditionalFormatting({
          ref: cell.address,
          rules: [{
            type: "expression", priority: 1,
            formulae: [`EXACT($B$${answerRow},"${expected}")`],
            style: { fill: { type: "pattern", pattern: "solid", fgColor: { argb: excelColor }, bgColor: { argb: excelColor } } },
          }],
        });
      }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    saveAs(new Blob([buffer]), "puzzle.xlsx");
  };

  // ── Styles ───────────────────────────────────────────────────────────────
  const S = {
    page: { fontFamily: "'Courier New', monospace", background: "#0f0f0f", minHeight: "100vh", color: "#e8e8e8", padding: "2rem" },
    label: { display: "block", fontSize: "0.75rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#888", marginBottom: "0.5rem" },
    input: { width: "100%", background: "#111", border: "1px solid #2a2a2a", color: "#e8e8e8", padding: "0.5rem", borderRadius: "4px", fontFamily: "inherit", fontSize: "0.85rem", boxSizing: "border-box" },
  };

  // ── Bulk LaTeX bar ───────────────────────────────────────────────────────
  const latexBarStyle = {
    display: "flex", alignItems: "center", gap: "0.75rem",
    background: "#1a1a1a", border: "1px solid #2a2a2a",
    borderRadius: "6px", padding: "0.6rem 1rem", marginBottom: "1rem",
    fontSize: "0.8rem", flexWrap: "wrap",
  };

  return (
    <div style={S.page}>
      <h1 style={{ fontSize: "1.8rem", fontWeight: 700, letterSpacing: "0.05em", marginBottom: "2rem", color: "#f0e040" }}>
        Pixel Art Activity Generator
      </h1>

      {/* Upload */}
      <section style={{ marginBottom: "2rem" }}>
        <label style={S.label}>Image</label>
        <input type="file" accept="image/*" onChange={handleUpload}
          style={{ background: "#1e1e1e", border: "1px solid #333", color: "#e8e8e8", padding: "0.5rem 0.75rem", borderRadius: "4px", cursor: "pointer" }} />
      </section>

      {/* Sliders + Preview */}
      <section style={{ display: "flex", gap: "2rem", marginBottom: "2rem", flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 280px" }}>
          <div style={{ marginBottom: "1.5rem" }}>
            <label style={S.label}>Grid Resolution: <span style={{ color: "#f0e040" }}>{gridSize} × {gridSize}</span></label>
            <input type="range" min="10" max="80" value={gridSize}
              onChange={(e) => setGridSize(Number(e.target.value))} style={{ width: "100%", accentColor: "#f0e040" }} />
          </div>
          <div>
            <label style={S.label}>Number of Colors: <span style={{ color: "#f0e040" }}>{numColors}</span></label>
            <input type="range" min="2" max="80" value={numColors}
              onChange={(e) => setNumColors(Number(e.target.value))} style={{ width: "100%", accentColor: "#f0e040" }} />
          </div>
          <button onClick={generateExcel} style={{
            marginTop: "2rem", background: "#f0e040", color: "#0f0f0f", border: "none",
            padding: "0.75rem 2rem", borderRadius: "4px", fontWeight: 700, fontSize: "1rem",
            cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em",
          }}>Export to Excel</button>
        </div>
        <div style={{ flex: "0 0 auto" }}>
          <label style={S.label}>Preview</label>
          <canvas ref={previewCanvasRef}
            style={{ border: "1px solid #333", imageRendering: "pixelated", display: "block", background: "#1e1e1e", width: "300px", height: "300px" }} />
          {!image && <p style={{ fontSize: "0.75rem", color: "#555", marginTop: "0.5rem" }}>Upload an image to preview</p>}
        </div>
      </section>

      {/* Questions */}
      <section style={{ marginBottom: "2rem" }}>
        <label style={S.label}>Questions</label>

        {/* ── Bulk LaTeX control bar ── */}
        <div style={latexBarStyle}>
          <span style={{ color: "#888", marginRight: "0.25rem" }}>LaTeX:</span>
          <InfoTooltip>{LATEX_INFO}</InfoTooltip>

          <button
            onClick={() => setAllLatex(true)}
            style={{
              background: allLatex ? "#f0e040" : "#2a2a2a",
              color: allLatex ? "#0f0f0f" : "#aaa",
              border: "1px solid #444", borderRadius: "4px",
              padding: "0.25rem 0.75rem", cursor: "pointer",
              fontFamily: "inherit", fontSize: "0.75rem", fontWeight: allLatex ? 700 : 400,
            }}
          >Enable all</button>

          <button
            onClick={() => setAllLatex(false)}
            style={{
              background: !someLatex ? "#f0e040" : "#2a2a2a",
              color: !someLatex ? "#0f0f0f" : "#aaa",
              border: "1px solid #444", borderRadius: "4px",
              padding: "0.25rem 0.75rem", cursor: "pointer",
              fontFamily: "inherit", fontSize: "0.75rem", fontWeight: !someLatex ? 700 : 400,
            }}
          >Disable all</button>

          <span style={{ color: "#555", fontSize: "0.72rem", marginLeft: "auto" }}>
            {qa.filter(q => q.l).length}/{qa.length} using LaTeX
          </span>
        </div>

        {/* ── Individual question cards ── */}
        {qa.map((item, i) => (
          <div key={i} style={{ background: "#1e1e1e", border: "1px solid #2a2a2a", borderRadius: "6px", padding: "1rem", marginBottom: "0.75rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
              <span style={{ fontSize: "0.7rem", color: "#ccc", letterSpacing: "0.1em" }}>Q{i+1} — Color {i+1}</span>

              <button onClick={() => removeQA(i)}
                style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: "1rem" }}>✕</button>
            </div>

            <textarea
              style={{ ...S.input, resize: "vertical" }}
              placeholder={item.l ? "LaTeX question (e.g. \\frac{x}{2} = 4)" : "Question"}
              rows={2}
              value={item.q}
              onChange={(e) => updateQA(i, "q", e.target.value)}
            />
            {/* LaTeX preview */}
            {item.l && item.q.trim() && (
              <div style={{ marginTop: "0.5rem",  marginBottom: "1rem", padding: "0.5rem 1rem", background: "#0a0a0a", borderRadius: "4px", overflowX: "auto", borderLeft: "2px solid #f0e040" }}>
                <BlockMath math={item.q} />
              </div>
            )}
            {/* Per-question LaTeX toggle */}
              <label style={{ margin: "0.5rem", display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer", userSelect: "none" }}>
                <span style={{ fontSize: "0.72rem", color: item.l ? "#f0e040" : "#666" }}>
                  {item.l ? "LaTeX on" : "Plain text"}
                </span>
                {/* Toggle switch */}
                <span style={{
                  position: "relative", display: "inline-block",
                  width: "36px", height: "20px",
                }}>
                  <span style={{
                    position: "absolute", inset: 0, borderRadius: "20px", cursor: "pointer",
                    background: item.l ? "#f0e040" : "#333",
                    transition: "background 0.2s",
                  }} onClick={() => updateQA(i, "l", !item.l)} />
                  <input
                    type="checkbox"
                    checked={item.l}
                    style={{ opacity: 0, width: 0, height: 0, position: "absolute" }}
                  />
                  <span style={{
                    position: "absolute", top: "3px",
                    left: item.l ? "19px" : "3px",
                    width: "14px", height: "14px", borderRadius: "50%",
                    background: item.l ? "#0f0f0f" : "#888",
                    transition: "left 0.2s", pointerEvents: "none",
                  }} />
                </span>
              </label>


            <input
              style={{ ...S.input, color: "#f0e040", marginTop: "0.5rem" }}
              placeholder="Answer (exact text match)"
              value={item.a}
              onChange={(e) => updateQA(i, "a", e.target.value)}
            />
          </div>
        ))}

        <button onClick={addQA} style={{
          background: "#1e1e1e", border: "1px dashed #444", color: "#888",
          padding: "0.5rem 1.25rem", borderRadius: "4px", cursor: "pointer",
          fontSize: "0.85rem", width: "100%",
        }}>+ Add Question</button>
      </section>
    </div>
  );
}
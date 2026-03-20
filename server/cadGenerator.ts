import PDFDocument from 'pdfkit';
import fs from 'fs';
import Drawing from 'dxf-writer';

export interface Sign {
  sign_code: string;
  distance_ft: number;
  label: string;
}

export interface Blueprint {
  primary_approach: Sign[];
  opposing_approach: Sign[];
  taper: {
    length_ft: number;
    device_type: string;
  };
  downstream_taper: {
    length_ft: number;
  };
  engineering_notes: string;
}

// ===================================================================
// PDF HELPER FUNCTIONS
// ===================================================================
function drawTitleBlock(doc: any, sheetNum: number, totalSheets: number) {
  doc.lineWidth(1).strokeColor('black');
  doc.rect(20, 720, 1184, 60).stroke();

  doc.moveTo(200, 720).lineTo(200, 780).stroke();
  doc.moveTo(350, 720).lineTo(350, 780).stroke();
  doc.moveTo(600, 720).lineTo(600, 780).stroke();
  doc.moveTo(800, 720).lineTo(800, 780).stroke();
  doc.moveTo(1050, 720).lineTo(1050, 780).stroke();

  doc.moveTo(200, 740).lineTo(350, 740).stroke();
  doc.moveTo(200, 760).lineTo(350, 760).stroke();
  doc.moveTo(1050, 740).lineTo(1204, 740).stroke();
  doc.moveTo(1050, 760).lineTo(1204, 760).stroke();

  doc.fontSize(8).fillColor('black');
  doc.text("REVISIONS", 25, 725, { width: 170, align: 'center', lineBreak: false });
  doc.text("DESIGNED", 205, 728, { width: 140, lineBreak: false });
  doc.text("DETAILED", 205, 748, { width: 140, lineBreak: false });
  doc.text("CHECKED", 205, 768, { width: 140, lineBreak: false });

  doc.fontSize(12).text("IDAHO TRANSPORTATION DEPARTMENT", 355, 740, { width: 240, align: 'center', lineBreak: false });

  doc.fontSize(10).text("PROJECT NO.", 605, 725, { width: 190, lineBreak: false });
  doc.fontSize(12).text("A023(541)", 605, 750, { width: 190, align: 'center', lineBreak: false });

  doc.fontSize(10).text("TEMPORARY TRAFFIC CONTROL PLAN", 805, 725, { width: 240, align: 'center', lineBreak: false });
  doc.fontSize(14).text("SH-55 CLEAR CR TO CASCADE", 805, 750, { width: 240, align: 'center', lineBreak: false });

  doc.fontSize(12).text("ENGLISH", 1055, 725, { width: 140, lineBreak: false });
  doc.fontSize(8).text("COUNTY: VALLEY", 1055, 748, { width: 140, lineBreak: false });
  doc.text(`SHEET ${sheetNum} OF ${totalSheets}`, 1055, 768, { width: 140, lineBreak: false });
}

function drawDimensionLine(doc: any, x1: number, x2: number, y: number, text: string) {
  doc.lineWidth(1).strokeColor('black');
  doc.moveTo(x1, y).lineTo(x2, y).stroke();
  doc.moveTo(x1, y - 5).lineTo(x1, y + 5).stroke();
  doc.moveTo(x2, y - 5).lineTo(x2, y + 5).stroke();

  doc.fontSize(8).fillColor('black');
  const textWidth = doc.widthOfString(text);
  doc.text(text, x1 + (x2 - x1) / 2 - textWidth / 2, y - 10, { lineBreak: false });
}

function drawSign(doc: any, x: number, diamondY: number, code: string, label: string) {
  doc.lineWidth(1).strokeColor('black');
  doc.save().translate(x, diamondY).rotate(45).rect(-15, -15, 30, 30).fillAndStroke('#ffffff', 'black').restore();
  doc.fontSize(8).fillColor('black');
  doc.text(`${code}\n${label}`, x - 40, diamondY + 30, { width: 80, align: 'center' });
}

function drawWorkArea(doc: any, x1: number, x2: number, y1: number, y2: number) {
  doc.lineWidth(1).strokeColor('black');
  doc.rect(x1, y1, x2 - x1, y2 - y1).stroke();
  doc.save();
  doc.rect(x1, y1, x2 - x1, y2 - y1).clip();
  for (let i = x1 - (y2 - y1) * 2; i < x2 + (y2 - y1) * 2; i += 10) {
    doc.moveTo(i, y1).lineTo(i + (y2 - y1), y2).stroke();
    doc.moveTo(i + (y2 - y1), y1).lineTo(i, y2).stroke();
  }
  doc.restore();
}

// ===================================================================
// PARAMETRIC DXF GENERATOR — FULL CAD LAYER PARITY
// ===================================================================
function generateDXF(blueprint: Blueprint, dxfPath: string): void {
  const d = new Drawing();
  d.setUnits('Feet');

  // --- Define CAD Layers ---
  d.addLayer('L-ROAD-EDGE', Drawing.ACI.WHITE, 'CONTINUOUS');
  d.addLayer('L-ROAD-CNTR', Drawing.ACI.YELLOW, 'CONTINUOUS');
  d.addLayer('L-TTC-WORK', Drawing.ACI.RED, 'CONTINUOUS');
  d.addLayer('L-TTC-TAPER', Drawing.ACI.MAGENTA, 'CONTINUOUS');
  d.addLayer('L-TTC-SIGN', Drawing.ACI.GREEN, 'CONTINUOUS');
  d.addLayer('L-ANNO-TEXT', Drawing.ACI.CYAN, 'CONTINUOUS');
  d.addLayer('L-ANNO-DIMS', Drawing.ACI.WHITE, 'CONTINUOUS');
  d.addLayer('L-TITLE', Drawing.ACI.WHITE, 'CONTINUOUS');

  // --- Roadway Edges ---
  d.setActiveLayer('L-ROAD-EDGE');
  d.drawLine(0, 50, 1200, 50);
  d.drawLine(0, -50, 1200, -50);

  // --- Centerline ---
  d.setActiveLayer('L-ROAD-CNTR');
  d.drawLine(0, 0, 1200, 0);

  // --- Work Area ---
  d.setActiveLayer('L-TTC-WORK');
  d.drawRect(650, -50, 1000, 0);
  d.setActiveLayer('L-ANNO-TEXT');
  d.drawText(750, -25, 10, 0, "WORK AREA");

  // --- Upstream Taper ---
  d.setActiveLayer('L-TTC-TAPER');
  d.drawLine(550, -50, 650, 0);
  d.setActiveLayer('L-ANNO-DIMS');
  d.drawText(550, -70, 8, 0, `TAPER: ${blueprint.taper.length_ft} FT (${blueprint.taper.device_type})`);

  // --- Downstream Taper ---
  d.setActiveLayer('L-TTC-TAPER');
  d.drawLine(1000, 0, 1050, -50);
  d.setActiveLayer('L-ANNO-DIMS');
  d.drawText(1000, -70, 8, 0, `DOWNSTREAM TAPER: ${blueprint.downstream_taper.length_ft} FT`);

  // --- Primary Approach Signs (Dynamic Spacing) ---
  const priCount = blueprint.primary_approach.length;
  const priStartX = 100;
  const priEndX = 500;
  const priStep = priCount > 1 ? (priEndX - priStartX) / (priCount - 1) : 0;

  blueprint.primary_approach.forEach((sign, i) => {
    const x = priStartX + i * priStep;
    d.setActiveLayer('L-TTC-SIGN');
    d.drawRect(x - 5, -95, x + 5, -85);
    d.setActiveLayer('L-ANNO-TEXT');
    d.drawText(x - 20, -110, 6, 0, sign.sign_code);
    d.drawText(x - 20, -120, 5, 0, sign.label);
    d.setActiveLayer('L-ANNO-DIMS');
    d.drawText(x - 10, -130, 5, 0, `${sign.distance_ft} FT`);
  });

  // --- Opposing Approach Signs (Dynamic Spacing) ---
  const oppCount = blueprint.opposing_approach.length;
  const oppStartX = 1100;
  const oppStep = oppCount > 1 ? (priEndX - priStartX) / (oppCount - 1) : 0;

  blueprint.opposing_approach.forEach((sign, i) => {
    const x = oppStartX + i * oppStep;
    d.setActiveLayer('L-TTC-SIGN');
    d.drawRect(x - 5, 85, x + 5, 95);
    d.setActiveLayer('L-ANNO-TEXT');
    d.drawText(x - 20, 100, 6, 0, sign.sign_code);
    d.drawText(x - 20, 110, 5, 0, sign.label);
    d.setActiveLayer('L-ANNO-DIMS');
    d.drawText(x - 10, 120, 5, 0, `${sign.distance_ft} FT`);
  });

  // --- Engineering Notes ---
  d.setActiveLayer('L-ANNO-TEXT');
  d.drawText(-500, 200, 8, 0, "ENGINEERING NOTES:");
  const noteLines = blueprint.engineering_notes.split('\n').slice(0, 10);
  noteLines.forEach((line, i) => {
    d.drawText(-500, 200 - (i + 1) * 15, 6, 0, line.trim().substring(0, 80));
  });

  // --- Title Block ---
  d.setActiveLayer('L-TITLE');
  d.drawRect(-500, -200, 1700, -180);
  d.drawText(-495, -195, 8, 0, "IDAHO TRANSPORTATION DEPARTMENT");
  d.drawText(0, -195, 8, 0, "TEMPORARY TRAFFIC CONTROL PLAN");
  d.drawText(800, -195, 8, 0, "SH-55 CLEAR CR TO CASCADE");
  d.drawText(1400, -195, 6, 0, "SHEET 1 OF 2");

  fs.writeFileSync(dxfPath, d.toDxfString(), 'utf8');
}

// ===================================================================
// MAIN EXPORT — GENERATES PDF (2 SHEETS) + DXF
// ===================================================================
export async function generateCAD(
  blueprint: any,
  staticMapBase64: string | null,
  startCoords: any,
  endCoords: any,
  pdfPath: string,
  dxfPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'tabloid', layout: 'landscape', margin: 0, autoFirstPage: false });
      const pdfStream = fs.createWriteStream(pdfPath);

      const onPdfFinished = () => {
        try {
          generateDXF(blueprint, dxfPath);
          console.log(`CAD Generation Complete. PDF: ${pdfPath} | DXF: ${dxfPath}`);
          resolve();
        } catch (dxfErr) {
          reject(new Error(`DXF write failed: ${dxfErr}`));
        }
      };

      pdfStream.on('finish', onPdfFinished);
      pdfStream.on('error', (err) => reject(new Error(`PDF stream error: ${err}`)));
      doc.on('error', (err) => reject(new Error(`PDFKit doc error: ${err}`)));
      doc.pipe(pdfStream);

      // ================================================================
      // SHEET 1: LINEAR SCHEMATIC (TYPICAL TTC)
      // ================================================================
      doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

      doc.fontSize(16).fillColor('black');
      doc.text("TYPICAL TEMPORARY TRAFFIC CONTROL - N.T.S.", 0, 30, { align: 'center' });

      // Notes Box
      doc.lineWidth(1).strokeColor('black');
      doc.rect(20, 20, 300, 250).stroke();
      doc.fontSize(10).fillColor('black').text("NOTES:", 25, 25, { underline: true });
      doc.fontSize(8).text(blueprint.engineering_notes || '', 25, 45, { width: 290, align: 'left' });

      // Roadway
      doc.lineWidth(2).strokeColor('black');
      doc.moveTo(50, 350).lineTo(1150, 350).stroke();
      doc.lineWidth(1).dash(10, { space: 10 });
      doc.moveTo(50, 400).lineTo(1150, 400).stroke();
      doc.undash();
      doc.lineWidth(2);
      doc.moveTo(50, 450).lineTo(1150, 450).stroke();

      // Work Area
      drawWorkArea(doc, 650, 1000, 405, 445);
      doc.fillColor('black').fontSize(12).text("WORK AREA", 680, 420);

      // Upstream Taper
      doc.lineWidth(1).strokeColor('black');
      doc.moveTo(550, 450).lineTo(650, 405).stroke();
      for (let i = 0; i <= 10; i++) {
        doc.circle(550 + (i * 10), 450 - (i * 4.5), 3).fillAndStroke('orange', 'black');
      }
      drawDimensionLine(doc, 550, 650, 465, `TAPER: ${blueprint.taper.length_ft} FT`);
      drawDimensionLine(doc, 650, 1000, 465, `WORK AREA`);

      // Downstream Taper
      doc.moveTo(1000, 405).lineTo(1050, 450).stroke();
      for (let i = 0; i <= 10; i++) {
        doc.circle(1000 + (i * 5), 405 + (i * 4.5), 3).fillAndStroke('orange', 'black');
      }
      drawDimensionLine(doc, 1000, 1050, 465, `TAPER: ${blueprint.downstream_taper.length_ft} FT`);

      // ---- DYNAMIC Primary Approach Signs ----
      const primaryCount = blueprint.primary_approach.length;
      const primaryStartX = 300;
      const primaryEndX = 700;
      const primaryStep = primaryCount > 1 ? (primaryEndX - primaryStartX) / (primaryCount - 1) : 0;

      blueprint.primary_approach.forEach((sign: Sign, index: number) => {
        const x = primaryStartX + (index * primaryStep);
        drawSign(doc, x, 600, sign.sign_code, sign.label);

        if (index < primaryCount - 1) {
          const nextX = primaryStartX + ((index + 1) * primaryStep);
          drawDimensionLine(doc, x, nextX, 550, `${sign.distance_ft} FT`);
        } else {
          drawDimensionLine(doc, x, 550, 550, `${sign.distance_ft} FT`);
        }
      });

      // ---- DYNAMIC Opposing Approach Signs ----
      const opposingCount = blueprint.opposing_approach.length;
      const opposingStartX = 1100;
      const opposingStep = opposingCount > 1 ? (opposingStartX - (opposingStartX - 400)) / (opposingCount - 1) : 0;

      blueprint.opposing_approach.forEach((sign: Sign, index: number) => {
        const x = opposingStartX - (index * opposingStep);
        drawSign(doc, x, 150, sign.sign_code, sign.label);

        if (index < opposingCount - 1) {
          const nextX = opposingStartX - ((index + 1) * opposingStep);
          drawDimensionLine(doc, nextX, x, 280, `${sign.distance_ft} FT`);
        } else {
          drawDimensionLine(doc, 650, x, 280, `${sign.distance_ft} FT`);
        }
      });

      drawTitleBlock(doc, 1, 2);

      // ================================================================
      // SHEET 2: GEO-STAMPED SATELLITE OVERLAY (SITE PLAN)
      // ================================================================
      doc.addPage({ size: 'tabloid', layout: 'landscape', margin: 0 });

      doc.fontSize(16).fillColor('black');
      doc.text("SITE-SPECIFIC WORK ZONE LAYOUT", 0, 30, { align: 'center' });

      // Image placement: centered on the 1224x792 page
      const imgX = 312;
      const imgY = 196;
      const imgW = 600;
      const imgH = 400;

      if (staticMapBase64) {
        try {
          const imgBuffer = Buffer.from(staticMapBase64, 'base64');
          doc.image(imgBuffer, imgX, imgY, { width: imgW, height: imgH });
          console.log(`Sheet 2: Satellite image stamped at (${imgX}, ${imgY}), size ${imgW}x${imgH}`);
        } catch (imgErr) {
          console.warn('Failed to embed satellite image on Sheet 2:', imgErr);
          doc.rect(imgX, imgY, imgW, imgH).stroke();
          doc.fontSize(12).text("SATELLITE IMAGE UNAVAILABLE", imgX + 150, imgY + 190);
        }
      } else {
        doc.rect(imgX, imgY, imgW, imgH).stroke();
        doc.fontSize(12).text("NO SATELLITE IMAGE PROVIDED", imgX + 150, imgY + 190);
      }

      // --- WEB MERCATOR PROJECTION ---
      // The Google Static Map is centered on startCoords with zoom=18, size=600x400.
      // startCoords maps to the exact center of the image on the PDF: (612, 396)
      if (startCoords && endCoords && staticMapBase64) {
        const centerPdfX = imgX + imgW / 2; // 612
        const centerPdfY = imgY + imgH / 2; // 396

        const latDiff = startCoords.lat - endCoords.lat;
        const lngDiff = endCoords.lng - startCoords.lng;
        const pixelsPerDegreeLat = (256 * Math.pow(2, 18)) / 360;
        const pixelsPerDegreeLng = pixelsPerDegreeLat * Math.cos((startCoords.lat * Math.PI) / 180);

        const endPdfX = centerPdfX + (lngDiff * pixelsPerDegreeLng);
        const endPdfY = centerPdfY + (latDiff * pixelsPerDegreeLat);

        console.log(`Mercator Projection: Start(${centerPdfX}, ${centerPdfY}) → End(${endPdfX.toFixed(1)}, ${endPdfY.toFixed(1)})`);

        // Draw thick dashed red line for work zone boundary
        doc.lineWidth(4).strokeColor('red').dash(8, { space: 4 });
        doc.moveTo(centerPdfX, centerPdfY).lineTo(endPdfX, endPdfY).stroke();
        doc.undash();

        // Start pin marker (green)
        doc.circle(centerPdfX, centerPdfY, 8).fillAndStroke('#22c55e', '#166534');
        doc.fontSize(7).fillColor('white');
        doc.text("S", centerPdfX - 3, centerPdfY - 4, { lineBreak: false });

        // End pin marker (red)
        doc.circle(endPdfX, endPdfY, 8).fillAndStroke('#ef4444', '#991b1b');
        doc.fontSize(7).fillColor('white');
        doc.text("E", endPdfX - 3, endPdfY - 4, { lineBreak: false });

        // Coordinate labels
        doc.fillColor('black').fontSize(7);
        doc.text(`START: ${startCoords.lat.toFixed(5)}, ${startCoords.lng.toFixed(5)}`, centerPdfX + 12, centerPdfY - 4, { lineBreak: false });
        doc.text(`END: ${endCoords.lat.toFixed(5)}, ${endCoords.lng.toFixed(5)}`, endPdfX + 12, endPdfY - 4, { lineBreak: false });
      }

      // Legend / disclaimer
      doc.fillColor('black').fontSize(8);
      doc.text("WORK ZONE BOUNDARY — PROJECTED FROM GPS COORDINATES VIA WEB MERCATOR", imgX, imgY + imgH + 10, { width: imgW, align: 'center' });
      doc.text("NOTE: Work zone line is mathematically projected. Verify on-site before construction.", imgX, imgY + imgH + 23, { width: imgW, align: 'center' });

      drawTitleBlock(doc, 2, 2);

      // End PDF → triggers 'finish' → DXF write → resolve()
      doc.end();

    } catch (err) {
      reject(err);
    }
  });
}

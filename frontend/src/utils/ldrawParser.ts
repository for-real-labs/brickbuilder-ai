/**
 * Enhanced LDraw Parser for React Instruction App
 * Based on web_lic's ld_parse.js with improvements for React integration
 */

export interface LDrawColor {
  name: string;
  color: string;
  edge: string;
  rgba: number[];
  edgeRgba: number[];
}

export interface LDrawPart {
  colorCode: number;
  x: number;
  y: number;
  z: number;
  matrix: number[]; // 4x4 transformation matrix as 16 elements
  filename: string;
}

export interface LDrawStep {
  stepNumber: number;
  parts: LDrawPart[];
  cumulativeParts: LDrawPart[]; // All parts up to this step
}

export interface LDrawModel {
  filename: string;
  name: string;
  parts: LDrawPart[];
  steps: LDrawStep[];
  boundingBox: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
}

// Standard LEGO color table (from web_lic)
export const LEGO_COLORS: Record<number, LDrawColor> = {
  0: { name: 'Black', color: '#05131D', edge: '#595959', rgba: [0.129, 0.129, 0.129, 1.0], edgeRgba: [0.349, 0.349, 0.349, 1.0] },
  1: { name: 'Blue', color: '#0055BF', edge: '#333333', rgba: [0.0, 0.20, 0.70, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  2: { name: 'Green', color: '#237841', edge: '#333333', rgba: [0.0, 0.55, 0.084, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  3: { name: 'Dark Turquoise', color: '#008F9B', edge: '#333333', rgba: [0.0, 0.45, 0.45, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  4: { name: 'Red', color: '#C91A09', edge: '#333333', rgba: [0.77, 0.0, 0.15, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  5: { name: 'Dark Pink', color: '#C870A0', edge: '#333333', rgba: [0.85, 0.45, 0.67, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  6: { name: 'Brown', color: '#583927', edge: '#333333', rgba: [0.36, 0.25, 0.18, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  7: { name: 'Light Gray', color: '#9BA19D', edge: '#333333', rgba: [0.65, 0.65, 0.65, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  8: { name: 'Dark Gray', color: '#6D6E5C', edge: '#333333', rgba: [0.40, 0.40, 0.40, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  9: { name: 'Light Blue', color: '#B4D2E3', edge: '#333333', rgba: [0.55, 0.85, 0.95, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  10: { name: 'Bright Green', color: '#4B9F4A', edge: '#333333', rgba: [0.4, 0.85, 0.35, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  11: { name: 'Light Turquoise', color: '#55BDB0', edge: '#333333', rgba: [0.3, 0.9, 0.9, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  12: { name: 'Salmon', color: '#F2705E', edge: '#333333', rgba: [0.95, 0.55, 0.45, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  13: { name: 'Pink', color: '#FC97AC', edge: '#333333', rgba: [0.95, 0.65, 0.85, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  14: { name: 'Yellow', color: '#F2CD37', edge: '#333333', rgba: [0.95, 0.9, 0.15, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  15: { name: 'White', color: '#FFFFFF', edge: '#333333', rgba: [0.95, 0.95, 0.95, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  16: { name: 'Main Color', color: '#7BB3F0', edge: '#333333', rgba: [0.8, 0.8, 0.8, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] },
  24: { name: 'Edge Color', color: '#7BB3F0', edge: '#333333', rgba: [0.15, 0.15, 0.15, 1.0], edgeRgba: [0.15, 0.15, 0.15, 1.0] },
  115: { name: 'Medium Lime', color: '#70B63C', edge: '#333333', rgba: [0.44, 0.71, 0.24, 1.0], edgeRgba: [0.2, 0.2, 0.2, 1.0] }
};

/**
 * Parse LDraw (.ldr) file content into a structured model with steps
 * This follows the same parsing logic as web_lic but adapted for React
 */
export class LDrawParser {
  
  /**
   * Parse LDR file content and return structured model with automatic step generation
   */
  static parseLDRContent(content: string, filename: string = 'model.ldr'): LDrawModel {
    const lines = content.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    const parts: LDrawPart[] = [];
    const steps: LDrawStep[] = [];
    let currentStepParts: LDrawPart[] = [];
    let stepNumber = 1;
    let rootSeen = false;
    
    for (const line of lines) {
      if (line.startsWith('0 FILE ')) {
        if (rootSeen) break;
        rootSeen = true;
        continue;
      }
      if (line.startsWith('0 STEP')) {
        // End current step and start new one
        if (currentStepParts.length > 0) {
          parts.push(...currentStepParts);
          const cumulativeParts = [...parts]; // All parts including this step
          steps.push({
            stepNumber,
            parts: [...currentStepParts],
            cumulativeParts
          });
          currentStepParts = [];
          stepNumber++;
        }
      } else if (line.startsWith('1 ')) {
        // Parse part line: 1 <color> <x> <y> <z> <a> <b> <c> <d> <e> <f> <g> <h> <i> <file>
        const tokens = line.split(/\s+/);
        if (tokens.length >= 15) {
          const colorCode = parseInt(tokens[1]);
          const x = parseFloat(tokens[2]);
          const y = parseFloat(tokens[3]);
          const z = parseFloat(tokens[4]);
          
          // Parse transformation matrix exactly as per LDraw specification
          // LDraw format: 1 <colour> x y z a b c d e f g h i <file>
          // The 9 values a b c d e f g h i represent a 3x3 transformation matrix:
          // | a  b  c |
          // | d  e  f |
          // | g  h  i |
          // Store these 9 values as they appear in the file for exact reconstruction
          const matrix = [
            parseFloat(tokens[5]),  // a
            parseFloat(tokens[6]),  // b
            parseFloat(tokens[7]),  // c
            parseFloat(tokens[8]),  // d
            parseFloat(tokens[9]),  // e
            parseFloat(tokens[10]), // f
            parseFloat(tokens[11]), // g
            parseFloat(tokens[12]), // h
            parseFloat(tokens[13])  // i
          ];
          
          const partFilename = tokens[14];
          
          const part: LDrawPart = {
            colorCode,
            x, y, z,
            matrix,
            filename: partFilename
          };
          
          currentStepParts.push(part);
        }
      }
    }
    
    // Add final step if there are remaining parts
    if (currentStepParts.length > 0) {
      const cumulativeParts = [...parts, ...currentStepParts];
      steps.push({
        stepNumber,
        parts: [...currentStepParts],
        cumulativeParts
      });
      parts.push(...currentStepParts);
    }
    
    // Calculate bounding box
    const boundingBox = LDrawParser.calculateBoundingBox(parts);
    
    return {
      filename,
      name: filename.replace('.ldr', ''),
      parts,
      steps,
      boundingBox
    };
  }
  
  /**
   * Calculate the bounding box of all parts in the model
   */
  static embeddedDefinitions(content: string): string {
    const lines = content.split('\n');
    let files = 0;
    const index = lines.findIndex(line => line.trim().startsWith('0 FILE ') && ++files === 2);
    return index < 0 ? '' : lines.slice(index).join('\n');
  }

  static calculateBoundingBox(parts: LDrawPart[]): LDrawModel['boundingBox'] {
    if (parts.length === 0) {
      return {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 0, y: 0, z: 0 }
      };
    }
    
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    
    for (const part of parts) {
      minX = Math.min(minX, part.x);
      minY = Math.min(minY, part.y);
      minZ = Math.min(minZ, part.z);
      maxX = Math.max(maxX, part.x);
      maxY = Math.max(maxY, part.y);
      maxZ = Math.max(maxZ, part.z);
    }
    
    return {
      min: { x: minX, y: minY, z: minZ },
      max: { x: maxX, y: maxY, z: maxZ }
    };
  }
  
  /**
   * Convert LDR model to MPD format for Three.js LDrawLoader
   */
  static convertToMPD(model: LDrawModel): string {
    const lines: string[] = [];
    
    // MPD header
    lines.push(`0 FILE ${model.filename}`);
    lines.push(`0 ${model.name}`);
    lines.push(`0 Name: ${model.filename}`);
    lines.push(`0 Author: Instruction Generator`);
    lines.push('');
    
    // Add all parts
    for (const part of model.parts) {
      const matrixStr = part.matrix.join(' '); // All 9 transformation matrix elements
      lines.push(`1 ${part.colorCode} ${part.x} ${part.y} ${part.z} ${matrixStr} ${part.filename}`);
    }
    
    lines.push('0 NOFILE');
    lines.push('');
    
    return lines.join('\n');
  }
  
  /**
   * Get parts list with quantities for a step
   */
  static getPartsListForStep(step: LDrawStep): Array<{filename: string, quantity: number, colorCode: number}> {
    const partCounts = new Map<string, {quantity: number, colorCode: number}>();
    
    for (const part of step.parts) {
      const key = `${part.filename}_${part.colorCode}`;
      if (partCounts.has(key)) {
        partCounts.get(key)!.quantity++;
      } else {
        partCounts.set(key, {
          quantity: 1,
          colorCode: part.colorCode
        });
      }
    }
    
    return Array.from(partCounts.entries()).map(([key, data]) => ({
      filename: key.split('_')[0],
      quantity: data.quantity,
      colorCode: data.colorCode
    }));
  }
  
  /**
   * Generate step-wise MPD content for progressive building visualization
   */
  static generateStepMPDs(model: LDrawModel): Array<{stepNumber: number, mpdContent: string}> {
    return model.steps.map(step => {
      const stepModel: LDrawModel = {
        ...model,
        filename: `${model.filename}_step_${step.stepNumber}.mpd`,
        name: `${model.name} - Step ${step.stepNumber}`,
        parts: step.cumulativeParts
      };
      
      return {
        stepNumber: step.stepNumber,
        mpdContent: LDrawParser.convertToMPD(stepModel)
      };
    });
  }
}
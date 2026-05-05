/**
 * Playground Compiler
 * Compiles Playground Intermediate Language (PIL) into standard HTML/CSS/JS.
 */

export class PlaygroundCompiler {
  constructor() {
    this.twAbbreviations = {
      'fc': 'flex flex-col',
      'fr': 'flex flex-row',
      'aic': 'items-center',
      'aif': 'items-start',
      'ais': 'items-stretch',
      'jcc': 'justify-center',
      'jcb': 'justify-between',
      'jca': 'justify-around',
      'jcs': 'justify-start',
      'jce': 'justify-end',
      'fw': 'flex-wrap',
      'rel': 'relative',
      'abs': 'absolute',
      'fix': 'fixed',
      'tc': 'text-center',
      'tl': 'text-left',
      'tr': 'text-right',
      'fwb': 'font-bold',
      'fwn': 'font-normal',
      'fsi': 'italic',
      'wf': 'w-full',
      'hf': 'h-full',
      'h-scr': 'h-screen',
      'w-scr': 'w-screen',
      'bg-wh': 'bg-white',
      'bg-bl': 'bg-black',
      'bg-tr': 'bg-transparent',
      'c-wh': 'text-white',
      'c-bl': 'text-black',
    };

    this.cssAbbreviations = {
      'c': 'color',
      'bg': 'background',
      'bgc': 'background-color',
      'fs': 'font-size',
      'fw': 'font-weight',
      'ta': 'text-align',
      'm': 'margin',
      'mt': 'margin-top',
      'mb': 'margin-bottom',
      'ml': 'margin-left',
      'mr': 'margin-right',
      'p': 'padding',
      'pt': 'padding-top',
      'pb': 'padding-bottom',
      'pl': 'padding-left',
      'pr': 'padding-right',
      'br': 'border-radius',
      'b': 'border',
      'd': 'display',
      'w': 'width',
      'h': 'height',
      'lh': 'line-height',
      'ls': 'letter-spacing',
      'ts': 'text-shadow',
      'bs': 'box-shadow'
    };
  }

  getPromptContext() {
    return `
You MUST format your output using the Playground Intermediate Language (PIL). This drastically reduces token usage.
Wrap your entire output in \`\`\`pil ... \`\`\`.

=== PIL FORMAT ===
@IMAGE
// Optional block. Nano Banana Agent generates images based on prompts.
// Use these variables inside @HTML or @CSS by wrapping them in braces: {varName}
heroBg: A dark futuristic cityscape at sunset, high resolution, cinematic lighting
logo: Neon pink logo saying "NANO"

@HTML
// Indent-based HTML. Syntax: tag#id.class1.class2[attr="val"] Text content
// Use space for indentation (2 spaces = 1 level).
div.wf.h-scr.fc.aic.jcc[style="background-image: url('{heroBg}')"]
  img[src="{logo}"]
  h1#title.tc.c-wh.fs-2x Hello
  input#inp[type="text"][placeholder="Enter name"].p10.mt20
  button#btn.p10.mt10.bg-wh.c-bl Click

@CSS
// Minimal CSS. Selector on one line, indented properties below. Use abbreviations!
#title
  c: #ff0055
  ts: 0 4px 10px rgba(255,0,85,0.5)
.custom-card
  bg: rgba(255,255,255,0.1)
  br: 15px

@JS
// Write minimal Vanilla JS.
// Available micro-library:
// $() - query selector (returns single node if 1 match, else NodeList)
// on(selector, eventName, callback) - Event listener binding
let count = 0;
on('#btn', 'click', () => {
  count++;
  $('#title').innerText = \`Count \${count} - \${$('#inp').value}\`;
});
==================

CLASS ABBREVIATIONS FOR @HTML:
Layout: fc (flex-col), fr (flex-row), aic (items-center), jcc (justify-center), jcb (justify-between), fw (flex-wrap), rel (relative), abs (absolute), wf (w-full), hf (h-full), h-scr (h-screen)
Text: tc (text-center), tl, tr, fwb (font-bold), fsi (italic)
Colors: bg-wh, bg-bl, bg-tr, c-wh, c-bl
Sizes (Auto-expanded to pixel equivalents): mt20 -> mt-[20px], p10 -> p-[10px], br5 -> rounded-[5px], fs20 -> text-[20px]

CSS PROPERTY ABBREVIATIONS FOR @CSS:
c (color), bg (background), fs (font-size), fw (font-weight), m (margin), mt, mb, ml, mr, p (padding), pt, pb, pl, pr, br (border-radius), b (border), ts (text-shadow), bs (box-shadow)

IMPORTANT RULES:
1. ALWAYS use the abbreviations.
2. The @HTML block must be purely space-indented (no closing tags).
3. Do NOT output raw HTML, CSS or JS outside of the @ blocks.
`;
  }

  expandTailwindClass(cls) {
    if (this.twAbbreviations[cls]) return this.twAbbreviations[cls];
    let m;
    if ((m = cls.match(/^mt(\d+)$/))) return `mt-[${m[1]}px]`;
    if ((m = cls.match(/^mb(\d+)$/))) return `mb-[${m[1]}px]`;
    if ((m = cls.match(/^ml(\d+)$/))) return `ml-[${m[1]}px]`;
    if ((m = cls.match(/^mr(\d+)$/))) return `mr-[${m[1]}px]`;
    if ((m = cls.match(/^m(\d+)$/))) return `m-[${m[1]}px]`;
    if ((m = cls.match(/^pt(\d+)$/))) return `pt-[${m[1]}px]`;
    if ((m = cls.match(/^pb(\d+)$/))) return `pb-[${m[1]}px]`;
    if ((m = cls.match(/^pl(\d+)$/))) return `pl-[${m[1]}px]`;
    if ((m = cls.match(/^pr(\d+)$/))) return `pr-[${m[1]}px]`;
    if ((m = cls.match(/^p(\d+)$/))) return `p-[${m[1]}px]`;
    if ((m = cls.match(/^br(\d+)$/))) return `rounded-[${m[1]}px]`;
    if ((m = cls.match(/^fs(\d+)$/))) return `text-[${m[1]}px]`;
    return cls;
  }

  async parseIMAGE(pilImage) {
    const lines = pilImage.split('\n').filter(l => l.trim() !== '');
    const imageMap = {};
    const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("VITE_GEMINI_API_KEY not found. Skipping Nano Banana image generation.");
      return imageMap;
    }

    const promises = lines.map(async (line) => {
      if (line.trim().startsWith('//')) return;
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) return;
      const key = line.substring(0, colonIdx).trim();
      const prompt = line.substring(colonIdx + 1).trim();

      try {
        console.log(`[Playground] Nano Banana generating image for '${key}': ${prompt}`);
        
        // Use document event bus to show loading text if available
        if (window && window.dispatchEvent) {
            window.dispatchEvent(new CustomEvent('agent:progress', { detail: `Nano Banana generating image: ${prompt}` }));
        }

        // Use Gemini native image generation (imagen-3 was deprecated late 2025)
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image-preview:generateContent?key=${apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `Generate an image: ${prompt}` }] }],
            generationConfig: {
              responseModalities: ["IMAGE", "TEXT"]
            }
          })
        });

        if (!response.ok) {
           const errBody = await response.text();
           console.error(`Gemini API Error: ${response.status}`, errBody);
           return;
        }

        const data = await response.json();
        // Extract inline image from Gemini generateContent response
        const parts = data.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData) {
            const mimeType = part.inlineData.mimeType || 'image/png';
            const base64 = part.inlineData.data;
            if (base64) {
              const byteCharacters = atob(base64);
              const byteNumbers = new Array(byteCharacters.length);
              for (let i = 0; i < byteCharacters.length; i++) {
                  byteNumbers[i] = byteCharacters.charCodeAt(i);
              }
              const byteArray = new Uint8Array(byteNumbers);
              const blob = new Blob([byteArray], { type: mimeType });
              const url = URL.createObjectURL(blob);
              imageMap[key] = url;
              console.log(`[Playground] Image '${key}' generated successfully.`);
              break;
            }
          }
        }
      } catch (err) {
        console.error(`Error generating image for ${key}:`, err);
      }
    });

    await Promise.all(promises);
    return imageMap;
  }

  parseHTML(pilHtml) {
    const lines = pilHtml.split('\n').filter(l => l.trim() !== '');
    const root = { tag: 'div', children: [], parent: null, indent: -1 };
    let currentParent = root;

    for (const line of lines) {
      if (line.trim().startsWith('//')) continue;
      
      const indentStrMatch = line.match(/^\s*/);
      const indentStr = indentStrMatch ? indentStrMatch[0] : '';
      const indent = indentStr.length;
      const content = line.trim();
      
      while (indent <= currentParent.indent && currentParent.parent) {
        currentParent = currentParent.parent;
      }

      // Parse line: tag#id.class1.class2[attr="val"] text
      let tag = 'div';
      let id = '';
      let classes = [];
      let attrs = [];
      let text = '';

      // First split by space to separate selector from text, ignoring spaces inside brackets [] or quotes
      let firstSpaceIdx = -1;
      let bracketDepth = 0;
      let quoteChar = null;
      for (let i = 0; i < content.length; i++) {
        const char = content[i];
        if (quoteChar) {
          if (char === quoteChar) quoteChar = null;
        } else {
          if (char === '"' || char === "'") quoteChar = char;
          else if (char === '[') bracketDepth++;
          else if (char === ']') bracketDepth--;
          else if (char.match(/\s/) && bracketDepth === 0) {
            firstSpaceIdx = i;
            break;
          }
        }
      }

      let selectorStr = content;
      if (firstSpaceIdx !== -1) {
        selectorStr = content.substring(0, firstSpaceIdx);
        text = content.substring(firstSpaceIdx + 1);
      }

      // Parse tag
      const tagMatch = selectorStr.match(/^([a-zA-Z0-9-]+)/);
      if (tagMatch) tag = tagMatch[1];
      else if (selectorStr.startsWith('.') || selectorStr.startsWith('#') || selectorStr.startsWith('[')) {
        tag = 'div';
      }

      // Parse id
      const idMatch = selectorStr.match(/#([a-zA-Z0-9_-]+)/);
      if (idMatch) id = idMatch[1];

      // Parse classes
      const classRegex = /\.([a-zA-Z0-9_-]+)/g;
      let match;
      while ((match = classRegex.exec(selectorStr)) !== null) {
        classes.push(this.expandTailwindClass(match[1]));
      }

      // Parse attributes
      const attrRegex = /\[([^\]]+)\]/g;
      while ((match = attrRegex.exec(selectorStr)) !== null) {
        attrs.push(match[1]);
      }

      const node = {
        tag, id, classes, attrs, text, indent, children: [], parent: currentParent
      };
      
      currentParent.children.push(node);
      currentParent = node;
    }

    const renderNode = (node) => {
      if (node.indent === -1) {
        return node.children.map(renderNode).join('\n');
      }

      let classStr = node.classes.length > 0 ? ` class="${node.classes.join(' ')}"` : '';
      let idStr = node.id ? ` id="${node.id}"` : '';
      let attrStr = node.attrs.length > 0 ? ' ' + node.attrs.join(' ') : '';
      
      let html = `<${node.tag}${idStr}${classStr}${attrStr}>`;
      if (node.text) html += node.text;
      
      if (node.children.length > 0) {
        html += '\n' + node.children.map(renderNode).join('\n') + '\n';
      }
      
      // Self closing tags check
      if (!['input', 'img', 'br', 'hr', 'meta'].includes(node.tag)) {
        html += `</${node.tag}>`;
      }
      
      return html;
    };

    return renderNode(root);
  }

  parseCSS(pilCss) {
    const lines = pilCss.split('\n').filter(l => l.trim() !== '');
    let output = '';
    let currentSelector = '';

    for (const line of lines) {
      if (line.trim().startsWith('//')) continue;
      
      const isIndent = line.startsWith(' ') || line.startsWith('\t');
      if (!isIndent) {
        if (currentSelector) output += '}\n';
        currentSelector = line.trim();
        output += `${currentSelector} {\n`;
      } else {
        const propLine = line.trim();
        const colonIdx = propLine.indexOf(':');
        if (colonIdx !== -1) {
          const prop = propLine.substring(0, colonIdx).trim();
          const val = propLine.substring(colonIdx + 1).trim();
          const fullProp = this.cssAbbreviations[prop] || prop;
          output += `  ${fullProp}: ${val};\n`;
        }
      }
    }
    if (currentSelector) output += '}\n';
    return output ? `<style>\n${output}</style>` : '';
  }

  parseJS(pilJs) {
    if (!pilJs.trim()) return '';
    const microLib = `
const $ = (q) => { const r = document.querySelectorAll(q); return r.length === 1 ? r[0] : (r.length === 0 ? null : r); };
const on = (q, e, f) => { let els = $(q); if(!els)return; if(!els.forEach) els=[els]; els.forEach(el=>el.addEventListener(e,f)); };
`;
    return `<script>\n(function(){ \n${microLib}\n${pilJs.trim()}\n})();\n</script>`;
  }

  async compile(pilCode) {
    // Extract sections using regex
    const imgMatch = pilCode.match(/@IMAGE\s*([\s\S]*?)(?=@HTML|@CSS|@JS|$)/i);
    const htmlMatch = pilCode.match(/@HTML\s*([\s\S]*?)(?=@CSS|@JS|@IMAGE|$)/i);
    const cssMatch = pilCode.match(/@CSS\s*([\s\S]*?)(?=@HTML|@JS|@IMAGE|$)/i);
    const jsMatch = pilCode.match(/@JS\s*([\s\S]*?)(?=@HTML|@CSS|@IMAGE|$)/i);

    const imgPart = imgMatch ? imgMatch[1] : '';
    let htmlPart = htmlMatch ? htmlMatch[1] : '';
    let cssPart = cssMatch ? cssMatch[1] : '';
    const jsPart = jsMatch ? jsMatch[1] : '';

    const imageMap = imgPart ? await this.parseIMAGE(imgPart) : {};

    for (const [key, url] of Object.entries(imageMap)) {
       const regex = new RegExp(`\\{${key}\\}`, 'g');
       htmlPart = htmlPart.replace(regex, url);
       cssPart = cssPart.replace(regex, url);
    }

    const compiledHTML = this.parseHTML(htmlPart);
    const compiledCSS = this.parseCSS(cssPart);
    const compiledJS = this.parseJS(jsPart);

    // Combine everything into a single HTML structure
    return `
<!DOCTYPE html>
<html>
<head>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" />
  ${compiledCSS}
</head>
<body>
  ${compiledHTML}
  ${compiledJS}
</body>
</html>
`.trim();
  }
}

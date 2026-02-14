const puppeteer = require('puppeteer');
const fs = require('fs');

// ============================================================================
// HTML to Figma Scraper — Extracts full computed styles from a live web page
// ============================================================================

const DEFAULT_URL = 'http://localhost:5173/';
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };

(async () => {
    const url = process.argv[2] || DEFAULT_URL;
    const viewportWidth = parseInt(process.argv[3]) || DEFAULT_VIEWPORT.width;
    const viewportHeight = parseInt(process.argv[4]) || DEFAULT_VIEWPORT.height;

    console.log(`🌐 Scraping: ${url}`);
    console.log(`📐 Viewport: ${viewportWidth}x${viewportHeight}`);

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: viewportWidth, height: viewportHeight });

    try {
        await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    } catch (e) {
        console.error(`❌ Failed to load ${url}:`, e.message);
        await browser.close();
        process.exit(1);
    }

    console.log('✅ Page loaded. Extracting styles...');

    // ========================================================================
    // In-browser extraction: walks the DOM and reads getComputedStyle
    // ========================================================================
    const designData = await page.evaluate(() => {

        // --- Color Parsing Helpers ---

        function parseColor(colorStr) {
            if (!colorStr || colorStr === 'transparent' || colorStr === 'rgba(0, 0, 0, 0)') {
                return null;
            }
            // rgb(r, g, b) or rgba(r, g, b, a)
            const rgbaMatch = colorStr.match(/rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)/);
            if (rgbaMatch) {
                return {
                    r: parseFloat(rgbaMatch[1]) / 255,
                    g: parseFloat(rgbaMatch[2]) / 255,
                    b: parseFloat(rgbaMatch[3]) / 255,
                    a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1
                };
            }
            return null;
        }

        function colorToFigmaFill(color) {
            if (!color) return null;
            return {
                type: 'SOLID',
                color: { r: color.r, g: color.g, b: color.b },
                opacity: color.a
            };
        }

        // --- Gradient Parsing ---

        function parseGradient(bgImage) {
            if (!bgImage || bgImage === 'none') return null;

            // linear-gradient(angle, color-stop, color-stop, ...)
            const linearMatch = bgImage.match(/linear-gradient\(([^)]+)\)/);
            if (linearMatch) {
                return parseLinearGradient(linearMatch[1]);
            }

            // radial-gradient(...)
            const radialMatch = bgImage.match(/radial-gradient\(([^)]+)\)/);
            if (radialMatch) {
                return parseRadialGradient(radialMatch[1]);
            }

            return null;
        }

        function parseLinearGradient(content) {
            // Split intelligently — commas inside rgb/rgba shouldn't split
            const parts = splitGradientParts(content);
            if (parts.length < 2) return null;

            let angleDeg = 180; // default: top to bottom
            let colorStopStart = 0;

            // Check if first part is an angle
            const angleMatch = parts[0].trim().match(/^([\d.]+)deg$/);
            if (angleMatch) {
                angleDeg = parseFloat(angleMatch[1]);
                colorStopStart = 1;
            } else if (parts[0].trim().startsWith('to ')) {
                angleDeg = directionToAngle(parts[0].trim());
                colorStopStart = 1;
            }

            const stops = [];
            const colorParts = parts.slice(colorStopStart);
            for (let i = 0; i < colorParts.length; i++) {
                const stopStr = colorParts[i].trim();
                const { color, position } = parseColorStop(stopStr, i, colorParts.length);
                if (color) {
                    stops.push({
                        color: { r: color.r, g: color.g, b: color.b, a: color.a },
                        position: position
                    });
                }
            }

            if (stops.length < 2) return null;

            // Convert angle to Figma gradient handle positions
            const angleRad = (angleDeg - 90) * (Math.PI / 180);
            const cos = Math.cos(angleRad);
            const sin = Math.sin(angleRad);

            return {
                type: 'GRADIENT_LINEAR',
                gradientStops: stops,
                gradientHandlePositions: [
                    { x: 0.5 - cos * 0.5, y: 0.5 - sin * 0.5 },
                    { x: 0.5 + cos * 0.5, y: 0.5 + sin * 0.5 },
                    { x: 0.5 - sin * 0.5, y: 0.5 + cos * 0.5 }
                ]
            };
        }

        function parseRadialGradient(content) {
            const parts = splitGradientParts(content);
            if (parts.length < 2) return null;

            // Skip shape/size/position — just get color stops
            let colorStopStart = 0;
            // If first part contains 'circle', 'ellipse', 'at', etc., skip it
            if (parts[0] && !parts[0].trim().match(/^(rgb|hsl|#)/i)) {
                colorStopStart = 1;
            }

            const stops = [];
            const colorParts = parts.slice(colorStopStart);
            for (let i = 0; i < colorParts.length; i++) {
                const { color, position } = parseColorStop(colorParts[i].trim(), i, colorParts.length);
                if (color) {
                    stops.push({
                        color: { r: color.r, g: color.g, b: color.b, a: color.a },
                        position: position
                    });
                }
            }

            if (stops.length < 2) return null;

            return {
                type: 'GRADIENT_RADIAL',
                gradientStops: stops,
                gradientHandlePositions: [
                    { x: 0.5, y: 0.5 },
                    { x: 1, y: 0.5 },
                    { x: 0.5, y: 1 }
                ]
            };
        }

        function splitGradientParts(str) {
            const parts = [];
            let depth = 0;
            let current = '';
            for (const ch of str) {
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
                if (ch === ',' && depth === 0) {
                    parts.push(current);
                    current = '';
                } else {
                    current += ch;
                }
            }
            if (current) parts.push(current);
            return parts;
        }

        function directionToAngle(dir) {
            const map = {
                'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270,
                'to top right': 45, 'to top left': 315,
                'to bottom right': 135, 'to bottom left': 225
            };
            return map[dir] || 180;
        }

        function parseColorStop(str, index, total) {
            // e.g. "rgba(255,0,0,0.5) 50%" or just "red"
            let position = total > 1 ? index / (total - 1) : 0;

            // Try to extract percentage
            const percentMatch = str.match(/([\d.]+)%\s*$/);
            if (percentMatch) {
                position = parseFloat(percentMatch[1]) / 100;
                str = str.replace(/([\d.]+)%\s*$/, '').trim();
            }

            const color = parseColor(str);
            return { color, position };
        }

        // --- Shadow Parsing ---

        function parseBoxShadow(shadowStr) {
            if (!shadowStr || shadowStr === 'none') return [];

            const effects = [];
            // Split by comma, but not commas inside rgb/rgba
            const shadows = splitGradientParts(shadowStr);

            for (const shadow of shadows) {
                const trimmed = shadow.trim();
                const isInner = trimmed.startsWith('inset');
                const cleaned = trimmed.replace(/^inset\s*/, '');

                // Extract the color (could be at start or end)
                let color = null;
                let rest = cleaned;

                // Try extracting rgba/rgb from the string
                const rgbaMatch = cleaned.match(/rgba?\([^)]+\)/);
                if (rgbaMatch) {
                    color = parseColor(rgbaMatch[0]);
                    rest = cleaned.replace(rgbaMatch[0], '').trim();
                }

                // Parse numeric values: offsetX offsetY blur spread
                const nums = rest.match(/-?[\d.]+px/g);
                if (!nums || nums.length < 2) continue;

                const offsetX = parseFloat(nums[0]);
                const offsetY = parseFloat(nums[1]);
                const blur = nums[2] ? parseFloat(nums[2]) : 0;
                const spread = nums[3] ? parseFloat(nums[3]) : 0;

                if (!color) color = { r: 0, g: 0, b: 0, a: 0.25 };

                effects.push({
                    type: isInner ? 'INNER_SHADOW' : 'DROP_SHADOW',
                    color: { r: color.r, g: color.g, b: color.b, a: color.a },
                    offset: { x: offsetX, y: offsetY },
                    radius: blur,
                    spread: spread,
                    visible: true
                });
            }

            return effects;
        }

        // --- Image URL Extraction ---

        function extractBackgroundImageUrl(bgImage) {
            if (!bgImage || bgImage === 'none') return null;
            const urlMatch = bgImage.match(/url\(["']?([^"')]+)["']?\)/);
            return urlMatch ? urlMatch[1] : null;
        }

        // --- Text Alignment Mapping ---

        function mapTextAlign(align) {
            const map = {
                'left': 'LEFT', 'right': 'RIGHT',
                'center': 'CENTER', 'justify': 'JUSTIFIED',
                'start': 'LEFT', 'end': 'RIGHT'
            };
            return map[align] || 'LEFT';
        }

        // --- Text Decoration Mapping ---

        function mapTextDecoration(decoration) {
            if (!decoration || decoration === 'none') return 'NONE';
            if (decoration.includes('underline')) return 'UNDERLINE';
            if (decoration.includes('line-through')) return 'STRIKETHROUGH';
            return 'NONE';
        }

        // --- Font Weight to Figma Style ---

        function fontWeightToStyle(weight, fontStyle) {
            const w = parseInt(weight) || 400;
            const italic = fontStyle === 'italic';

            let style = 'Regular';
            if (w <= 100) style = 'Thin';
            else if (w <= 200) style = 'ExtraLight';
            else if (w <= 300) style = 'Light';
            else if (w <= 400) style = 'Regular';
            else if (w <= 500) style = 'Medium';
            else if (w <= 600) style = 'SemiBold';
            else if (w <= 700) style = 'Bold';
            else if (w <= 800) style = 'ExtraBold';
            else style = 'Black';

            if (italic) style += ' Italic';
            return style;
        }

        // --- Element Naming ---

        function getNodeName(el) {
            const tag = el.tagName.toLowerCase();
            if (el.id) return `${tag}#${el.id}`;
            const classes = el.className && typeof el.className === 'string'
                ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
                : '';
            return classes ? `${tag}${classes}` : tag;
        }

        // --- Border Extraction ---

        function extractBorders(cs) {
            const sides = ['Top', 'Right', 'Bottom', 'Left'];
            let hasAnyBorder = false;
            const strokes = [];
            let strokeWeight = 0;
            let strokeAlign = 'INSIDE'; // Figma default

            for (const side of sides) {
                const width = parseFloat(cs[`border${side}Width`]);
                const style = cs[`border${side}Style`];
                const color = parseColor(cs[`border${side}Color`]);

                if (width > 0 && style !== 'none' && color) {
                    hasAnyBorder = true;
                    strokeWeight = Math.max(strokeWeight, width);
                    // Use the first visible border color
                    if (strokes.length === 0) {
                        strokes.push(colorToFigmaFill(color));
                    }
                }
            }

            if (!hasAnyBorder) return null;

            return {
                strokes: strokes.filter(Boolean),
                strokeWeight,
                strokeAlign
            };
        }

        // --- Main DOM Walker ---

        function walkElement(el, parentRect) {
            // Skip invisible or empty elements
            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return null;

            const rect = el.getBoundingClientRect();

            // Skip zero-size elements (unless they're text-bearing)
            if (rect.width <= 0 && rect.height <= 0) return null;

            const node = {
                name: getNodeName(el),
                x: parentRect ? rect.left - parentRect.left : rect.left,
                y: parentRect ? rect.top - parentRect.top : rect.top,
                width: Math.max(rect.width, 1),
                height: Math.max(rect.height, 1)
            };

            // --- Determine node type ---
            const tag = el.tagName.toLowerCase();

            // SVG handling
            if (tag === 'svg') {
                node.type = 'SVG';
                node.svgContent = el.outerHTML;
                return node;
            }

            // Image handling
            if (tag === 'img') {
                node.type = 'IMAGE';
                node.imageUrl = el.src;
                node.name = `img${el.alt ? ': ' + el.alt : ''}`;
                return node;
            }

            // Video poster handling
            if (tag === 'video' && el.poster) {
                node.type = 'IMAGE';
                node.imageUrl = el.poster;
                return node;
            }

            // --- Check if this is a text-only node ---
            const hasOnlyTextChildren = Array.from(el.childNodes).every(
                c => c.nodeType === Node.TEXT_NODE ||
                    (c.nodeType === Node.ELEMENT_NODE &&
                        ['SPAN', 'STRONG', 'EM', 'B', 'I', 'A', 'CODE', 'SMALL', 'SUB', 'SUP', 'MARK', 'U', 'S', 'BR'].includes(c.tagName))
            );
            const textContent = el.innerText?.trim();

            if (hasOnlyTextChildren && textContent) {
                node.type = 'TEXT';
                node.characters = textContent;

                // Text styles
                const textColor = parseColor(cs.color);
                if (textColor) {
                    node.fills = [colorToFigmaFill(textColor)].filter(Boolean);
                }

                node.fontSize = parseFloat(cs.fontSize) || 16;
                node.fontFamily = cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
                node.fontWeight = cs.fontWeight;
                node.fontStyle = cs.fontStyle;
                node.figmaFontStyle = fontWeightToStyle(cs.fontWeight, cs.fontStyle);
                node.lineHeight = cs.lineHeight === 'normal'
                    ? { unit: 'AUTO' }
                    : { unit: 'PIXELS', value: parseFloat(cs.lineHeight) };
                node.letterSpacing = parseFloat(cs.letterSpacing) || 0;
                node.textAlignHorizontal = mapTextAlign(cs.textAlign);
                node.textDecoration = mapTextDecoration(cs.textDecorationLine || cs.textDecoration);

                // Text nodes can also have backgrounds (e.g., highlighted text, buttons)
                const bgFill = extractBackground(cs);
                if (bgFill) {
                    node.backgroundFills = Array.isArray(bgFill) ? bgFill : [bgFill];
                }

                // Borders on text containers
                const borderData = extractBorders(cs);
                if (borderData) {
                    node.strokes = borderData.strokes;
                    node.strokeWeight = borderData.strokeWeight;
                }

                // Corner radius
                extractCornerRadius(cs, node);

                // Effects
                const effects = parseBoxShadow(cs.boxShadow);
                if (effects.length > 0) node.effects = effects;

                // Opacity
                const opacity = parseFloat(cs.opacity);
                if (opacity < 1) node.opacity = opacity;

                return node;
            }

            // --- It's a container (FRAME) ---
            node.type = 'FRAME';
            node.clipsContent = (cs.overflow === 'hidden' || cs.overflow === 'clip' ||
                cs.overflowX === 'hidden' || cs.overflowY === 'hidden');

            // Fills (background)
            const fills = [];

            // Solid background color
            const bgColor = parseColor(cs.backgroundColor);
            if (bgColor) {
                const fill = colorToFigmaFill(bgColor);
                if (fill) fills.push(fill);
            }

            // Gradient background
            const gradient = parseGradient(cs.backgroundImage);
            if (gradient) {
                fills.push(gradient);
            }

            // Background image URL
            const bgImageUrl = extractBackgroundImageUrl(cs.backgroundImage);
            if (bgImageUrl && !gradient) {
                node.backgroundImageUrl = bgImageUrl;
            }

            node.fills = fills;

            // Borders → Strokes
            const borderData = extractBorders(cs);
            if (borderData) {
                node.strokes = borderData.strokes;
                node.strokeWeight = borderData.strokeWeight;
                node.strokeAlign = borderData.strokeAlign;
            }

            // Corner radius
            extractCornerRadius(cs, node);

            // Effects (box-shadow)
            const effects = parseBoxShadow(cs.boxShadow);
            if (effects.length > 0) node.effects = effects;

            // Opacity
            const opacity = parseFloat(cs.opacity);
            if (opacity < 1) node.opacity = opacity;

            // --- Walk children ---
            node.children = [];
            for (const child of el.children) {
                const childNode = walkElement(child, rect);
                if (childNode) {
                    node.children.push(childNode);
                }
            }

            // --- Pseudo-elements (::before, ::after) ---
            for (const pseudo of ['::before', '::after']) {
                const pcs = window.getComputedStyle(el, pseudo);
                const content = pcs.content;
                if (content && content !== 'none' && content !== 'normal' && content !== '""') {
                    const pseudoNode = extractPseudoElement(el, pcs, pseudo, rect);
                    if (pseudoNode) {
                        node.children.push(pseudoNode);
                    }
                }
            }

            return node;
        }

        function extractBackground(cs) {
            const fills = [];
            const bgColor = parseColor(cs.backgroundColor);
            if (bgColor) {
                const fill = colorToFigmaFill(bgColor);
                if (fill) fills.push(fill);
            }
            const gradient = parseGradient(cs.backgroundImage);
            if (gradient) fills.push(gradient);
            return fills.length > 0 ? fills : null;
        }

        function extractCornerRadius(cs, node) {
            const tl = parseFloat(cs.borderTopLeftRadius) || 0;
            const tr = parseFloat(cs.borderTopRightRadius) || 0;
            const br = parseFloat(cs.borderBottomRightRadius) || 0;
            const bl = parseFloat(cs.borderBottomLeftRadius) || 0;
            if (tl > 0 || tr > 0 || br > 0 || bl > 0) {
                node.topLeftRadius = tl;
                node.topRightRadius = tr;
                node.bottomRightRadius = br;
                node.bottomLeftRadius = bl;
            }
        }

        function extractPseudoElement(el, pcs, pseudo, parentRect) {
            const content = pcs.content.replace(/^["']|["']$/g, '');
            if (!content) return null;

            // Pseudo-elements don't have their own getBoundingClientRect
            // Approximate position based on parent
            const parentRectInfo = el.getBoundingClientRect();
            const width = parseFloat(pcs.width) || 0;
            const height = parseFloat(pcs.height) || 0;

            if (width <= 0 && height <= 0 && !content) return null;

            const node = {
                name: `${getNodeName(el)}${pseudo}`,
                type: 'TEXT',
                x: 0,
                y: 0,
                width: width || parentRectInfo.width,
                height: height || parseFloat(pcs.fontSize) || 16,
                characters: content
            };

            // Text styles
            const textColor = parseColor(pcs.color);
            if (textColor) {
                node.fills = [colorToFigmaFill(textColor)].filter(Boolean);
            }

            node.fontSize = parseFloat(pcs.fontSize) || 16;
            node.fontFamily = pcs.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
            node.figmaFontStyle = fontWeightToStyle(pcs.fontWeight, pcs.fontStyle);

            // Background on pseudo
            const bgFills = extractBackground(pcs);
            if (bgFills) {
                node.backgroundFills = bgFills;
            }

            return node;
        }

        // --- Kick it off ---
        const body = document.body;
        const rootRect = body.getBoundingClientRect();

        const result = walkElement(body, null);

        // Also capture page-level metadata
        return {
            pageTitle: document.title,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            fullHeight: Math.max(
                document.body.scrollHeight,
                document.documentElement.scrollHeight
            ),
            rootNode: result
        };
    });

    // ========================================================================
    // Post-processing: fetch images and convert to base64
    // ========================================================================
    console.log('🖼️  Fetching images...');

    async function fetchImageAsBase64(imageUrl) {
        try {
            // Resolve relative URLs
            const absoluteUrl = new URL(imageUrl, url).href;
            const response = await page.goto(absoluteUrl, { timeout: 10000 });
            if (response && response.ok()) {
                const buffer = await response.buffer();
                return buffer.toString('base64');
            }
        } catch (e) {
            console.warn(`  ⚠️  Could not fetch image: ${imageUrl}`);
        }
        return null;
    }

    // Walk the tree and fetch images
    let imageCount = 0;
    async function resolveImages(node) {
        if (!node) return;

        if (node.type === 'IMAGE' && node.imageUrl) {
            // Use Puppeteer to navigate + screenshot approach for images
            // Better: use page.evaluate to fetch as blob
            try {
                const base64 = await page.evaluate(async (imgUrl) => {
                    try {
                        const resp = await fetch(imgUrl);
                        const blob = await resp.blob();
                        return await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result.split(',')[1]);
                            reader.onerror = reject;
                            reader.readAsDataURL(blob);
                        });
                    } catch {
                        return null;
                    }
                }, node.imageUrl);

                if (base64) {
                    node.imageBase64 = base64;
                    imageCount++;
                }
            } catch (e) {
                console.warn(`  ⚠️  Could not fetch: ${node.imageUrl}`);
            }
        }

        if (node.backgroundImageUrl) {
            try {
                const base64 = await page.evaluate(async (imgUrl) => {
                    try {
                        const resp = await fetch(imgUrl);
                        const blob = await resp.blob();
                        return await new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result.split(',')[1]);
                            reader.onerror = reject;
                            reader.readAsDataURL(blob);
                        });
                    } catch {
                        return null;
                    }
                }, node.backgroundImageUrl);

                if (base64) {
                    node.backgroundImageBase64 = base64;
                    imageCount++;
                }
            } catch (e) {
                console.warn(`  ⚠️  Could not fetch bg image: ${node.backgroundImageUrl}`);
            }
        }

        if (node.children) {
            for (const child of node.children) {
                await resolveImages(child);
            }
        }
    }

    await resolveImages(designData.rootNode);
    console.log(`  📷 Fetched ${imageCount} images`);

    // ========================================================================
    // Write output
    // ========================================================================
    const outputPath = process.argv[5] || 'design.json';
    fs.writeFileSync(outputPath, JSON.stringify(designData, null, 2));

    // Quick stats
    let nodeCount = 0;
    function countNodes(n) {
        if (!n) return;
        nodeCount++;
        if (n.children) n.children.forEach(countNodes);
    }
    countNodes(designData.rootNode);

    console.log(`\n✨ Done! Generated ${outputPath}`);
    console.log(`   📊 ${nodeCount} nodes extracted`);
    console.log(`   📐 Page size: ${designData.viewportWidth}x${designData.fullHeight}`);

    await browser.close();
})();

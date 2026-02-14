// ============================================================================
// HTML to Figma Plugin — Creates Figma nodes from scraped design JSON
// ============================================================================

figma.showUI(__html__, { width: 450, height: 380 });

figma.ui.onmessage = async (msg) => {
    if (msg.type === 'import-design') {
        const data = msg.data;
        if (!data || !data.rootNode) {
            figma.notify('❌ Invalid design.json — missing rootNode');
            return;
        }

        figma.notify('🚀 Starting import...');
        sendProgress('Starting import...', 0);

        try {
            // Count total nodes for progress tracking
            let totalNodes = 0;
            let processedNodes = 0;
            countNodes(data.rootNode);

            function countNodes(n) {
                if (!n) return;
                totalNodes++;
                if (n.children) n.children.forEach(countNodes);
            }

            // Create root frame
            const rootFrame = figma.createFrame();
            rootFrame.name = data.pageTitle || 'Imported Web Page';
            rootFrame.resize(
                data.viewportWidth || 1440,
                data.fullHeight || data.viewportHeight || 900
            );

            // Process the root node
            await processNode(data.rootNode, rootFrame);

            // Center in viewport
            rootFrame.x = figma.viewport.center.x - rootFrame.width / 2;
            rootFrame.y = figma.viewport.center.y - rootFrame.height / 2;
            figma.viewport.scrollAndZoomIntoView([rootFrame]);

            sendProgress('Import complete!', 100);
            figma.notify(`✅ Import complete! ${processedNodes} layers created.`);

            // ================================================================
            // Recursive node processor
            // ================================================================
            async function processNode(node, parent) {
                if (!node) return null;

                processedNodes++;
                if (processedNodes % 50 === 0) {
                    sendProgress(
                        `Processing layers... (${processedNodes}/${totalNodes})`,
                        Math.round((processedNodes / totalNodes) * 100)
                    );
                }

                let figmaNode;

                switch (node.type) {
                    case 'TEXT':
                        figmaNode = await createTextNode(node);
                        break;

                    case 'SVG':
                        figmaNode = createSvgNode(node);
                        break;

                    case 'IMAGE':
                        figmaNode = await createImageNode(node);
                        break;

                    case 'FRAME':
                    default:
                        figmaNode = createFrameNode(node);
                        break;
                }

                if (!figmaNode) return null;

                // Position and size
                if (node.x !== undefined) figmaNode.x = node.x;
                if (node.y !== undefined) figmaNode.y = node.y;

                // Opacity
                if (node.opacity !== undefined && node.opacity < 1) {
                    figmaNode.opacity = node.opacity;
                }

                // Name
                if (node.name) figmaNode.name = node.name;

                // Append to parent
                if (parent && typeof parent.appendChild === 'function') {
                    parent.appendChild(figmaNode);
                }

                // Process children (only for frames)
                if (node.children && node.children.length > 0 && typeof figmaNode.appendChild === 'function') {
                    for (const child of node.children) {
                        await processNode(child, figmaNode);
                    }
                }

                return figmaNode;
            }

            // ================================================================
            // Frame Node (containers)
            // ================================================================
            function createFrameNode(node) {
                const frame = figma.createFrame();

                // Size
                const w = Math.max(node.width || 1, 1);
                const h = Math.max(node.height || 1, 1);
                frame.resize(w, h);

                // Clipping
                frame.clipsContent = node.clipsContent || false;

                // Fills
                if (node.fills && node.fills.length > 0) {
                    frame.fills = sanitizeFills(node.fills);
                } else {
                    frame.fills = []; // Transparent by default
                }

                // Strokes (borders)
                applyStrokes(frame, node);

                // Corner radius
                applyCornerRadius(frame, node);

                // Effects (shadows)
                applyEffects(frame, node);

                return frame;
            }

            // ================================================================
            // Text Node
            // ================================================================
            async function createTextNode(node) {
                // If this text node has a background, wrap it in a frame
                const hasBackground = node.backgroundFills && node.backgroundFills.length > 0;
                const hasBorder = node.strokes && node.strokes.length > 0;
                const hasRadius = (node.topLeftRadius || node.topRightRadius ||
                    node.bottomRightRadius || node.bottomLeftRadius);
                const hasEffects = node.effects && node.effects.length > 0;
                const needsWrapper = hasBackground || hasBorder || hasRadius || hasEffects;

                let wrapper = null;
                if (needsWrapper) {
                    wrapper = figma.createFrame();
                    wrapper.name = node.name || 'text-container';
                    wrapper.resize(
                        Math.max(node.width || 1, 1),
                        Math.max(node.height || 1, 1)
                    );
                    wrapper.clipsContent = false;

                    if (hasBackground) {
                        wrapper.fills = sanitizeFills(node.backgroundFills);
                    } else {
                        wrapper.fills = [];
                    }

                    applyStrokes(wrapper, node);
                    applyCornerRadius(wrapper, node);
                    applyEffects(wrapper, node);
                }

                // Create the text node
                const textNode = figma.createText();

                // Determine font to load
                const fontFamily = sanitizeFontFamily(node.fontFamily);
                const fontStyle = node.figmaFontStyle || 'Regular';

                // Try loading the exact font, fall back to Inter
                let loadedFont = false;
                const fontsToTry = [
                    { family: fontFamily, style: fontStyle },
                    { family: fontFamily, style: 'Regular' },
                    { family: 'Inter', style: fontStyle },
                    { family: 'Inter', style: 'Regular' }
                ];

                for (const font of fontsToTry) {
                    try {
                        await figma.loadFontAsync(font);
                        textNode.fontName = font;
                        loadedFont = true;
                        break;
                    } catch (e) {
                        // Try next
                    }
                }

                if (!loadedFont) {
                    // Absolute fallback
                    await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
                    textNode.fontName = { family: 'Inter', style: 'Regular' };
                }

                // Set text content
                textNode.characters = node.characters || '';

                // Font size
                if (node.fontSize) textNode.fontSize = node.fontSize;

                // Line height
                if (node.lineHeight) {
                    if (node.lineHeight.unit === 'AUTO') {
                        textNode.lineHeight = { unit: 'AUTO' };
                    } else if (node.lineHeight.value) {
                        textNode.lineHeight = {
                            unit: 'PIXELS',
                            value: node.lineHeight.value
                        };
                    }
                }

                // Letter spacing
                if (node.letterSpacing) {
                    textNode.letterSpacing = { unit: 'PIXELS', value: node.letterSpacing };
                }

                // Text alignment
                if (node.textAlignHorizontal) {
                    textNode.textAlignHorizontal = node.textAlignHorizontal;
                }

                // Text decoration
                if (node.textDecoration && node.textDecoration !== 'NONE') {
                    textNode.textDecoration = node.textDecoration;
                }

                // Text fills (color)
                if (node.fills && node.fills.length > 0) {
                    textNode.fills = sanitizeFills(node.fills);
                }

                // Sizing
                const w = Math.max(node.width || 1, 1);
                const h = Math.max(node.height || 1, 1);
                textNode.resize(w, h);
                textNode.textAutoResize = 'NONE';

                if (wrapper) {
                    textNode.x = 0;
                    textNode.y = 0;
                    wrapper.appendChild(textNode);
                    return wrapper;
                }

                return textNode;
            }

            // ================================================================
            // SVG Node
            // ================================================================
            function createSvgNode(node) {
                if (!node.svgContent) {
                    // Fallback: create a placeholder rectangle
                    const rect = figma.createRectangle();
                    rect.resize(Math.max(node.width || 24, 1), Math.max(node.height || 24, 1));
                    rect.fills = [{ type: 'SOLID', color: { r: 0.8, g: 0.8, b: 0.8 } }];
                    return rect;
                }

                try {
                    const svgNode = figma.createNodeFromSvg(node.svgContent);
                    if (node.width && node.height) {
                        svgNode.resize(
                            Math.max(node.width, 1),
                            Math.max(node.height, 1)
                        );
                    }
                    return svgNode;
                } catch (e) {
                    console.error('SVG parse error:', e);
                    const rect = figma.createRectangle();
                    rect.resize(Math.max(node.width || 24, 1), Math.max(node.height || 24, 1));
                    rect.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.7, b: 0.7 } }];
                    rect.name = 'SVG (parse error)';
                    return rect;
                }
            }

            // ================================================================
            // Image Node
            // ================================================================
            async function createImageNode(node) {
                const rect = figma.createRectangle();
                const w = Math.max(node.width || 100, 1);
                const h = Math.max(node.height || 100, 1);
                rect.resize(w, h);

                if (node.imageBase64) {
                    try {
                        // Decode base64 to Uint8Array
                        const raw = figma.base64Decode(node.imageBase64);
                        const image = figma.createImage(raw);
                        rect.fills = [{
                            type: 'IMAGE',
                            scaleMode: 'FILL',
                            imageHash: image.hash
                        }];
                    } catch (e) {
                        console.error('Image create error:', e);
                        rect.fills = [{
                            type: 'SOLID',
                            color: { r: 0.85, g: 0.85, b: 0.9 }
                        }];
                        rect.name = node.name || 'Image (load error)';
                    }
                } else if (node.imageUrl) {
                    // Try createImageAsync with URL
                    try {
                        const image = await figma.createImageAsync(node.imageUrl);
                        rect.fills = [{
                            type: 'IMAGE',
                            scaleMode: 'FILL',
                            imageHash: image.hash
                        }];
                    } catch (e) {
                        console.error('Image URL error:', e);
                        rect.fills = [{
                            type: 'SOLID',
                            color: { r: 0.85, g: 0.85, b: 0.9 }
                        }];
                        rect.name = node.name || 'Image (URL error)';
                    }
                } else {
                    rect.fills = [{
                        type: 'SOLID',
                        color: { r: 0.9, g: 0.9, b: 0.9 }
                    }];
                }

                return rect;
            }

            // ================================================================
            // Helpers
            // ================================================================

            function sanitizeFills(fills) {
                if (!fills || !Array.isArray(fills)) return [];

                return fills.map(fill => {
                    if (fill.type === 'SOLID') {
                        var c = fill.color || {};
                        return {
                            type: 'SOLID',
                            color: {
                                r: clamp(c.r || 0),
                                g: clamp(c.g || 0),
                                b: clamp(c.b || 0)
                            },
                            opacity: fill.opacity !== undefined ? clamp(fill.opacity) : 1
                        };
                    }

                    if (fill.type === 'GRADIENT_LINEAR' || fill.type === 'GRADIENT_RADIAL') {
                        return {
                            type: fill.type,
                            gradientStops: (fill.gradientStops || []).map(function (stop) {
                                var sc = stop.color || {};
                                return {
                                    color: {
                                        r: clamp(sc.r || 0),
                                        g: clamp(sc.g || 0),
                                        b: clamp(sc.b || 0),
                                        a: sc.a !== undefined ? clamp(sc.a) : 1
                                    },
                                    position: clamp(stop.position || 0)
                                };
                            }
                            ),
                            gradientTransform: fill.gradientHandlePositions
                                ? handlePositionsToTransform(fill.gradientHandlePositions)
                                : [[1, 0, 0], [0, 1, 0]]
                        };
                    }

                    return fill;
                }).filter(Boolean);
            }

            function handlePositionsToTransform(handles) {
                // Figma gradients use a 2x3 affine transform matrix
                // handles[0] = start, handles[1] = end, handles[2] = width handle
                if (!handles || handles.length < 3) {
                    return [[1, 0, 0], [0, 1, 0]];
                }

                const start = handles[0];
                const end = handles[1];
                const width = handles[2];

                // Direction vector
                const dx = end.x - start.x;
                const dy = end.y - start.y;

                // Width vector  
                const wx = width.x - start.x;
                const wy = width.y - start.y;

                return [
                    [dx, wx, start.x],
                    [dy, wy, start.y]
                ];
            }

            function applyStrokes(figmaNode, node) {
                if (node.strokes && node.strokes.length > 0) {
                    figmaNode.strokes = sanitizeFills(node.strokes);
                    if (node.strokeWeight) {
                        figmaNode.strokeWeight = node.strokeWeight;
                    }
                    figmaNode.strokeAlign = node.strokeAlign || 'INSIDE';
                }
            }

            function applyCornerRadius(figmaNode, node) {
                if (node.topLeftRadius !== undefined ||
                    node.topRightRadius !== undefined ||
                    node.bottomRightRadius !== undefined ||
                    node.bottomLeftRadius !== undefined) {
                    figmaNode.topLeftRadius = node.topLeftRadius || 0;
                    figmaNode.topRightRadius = node.topRightRadius || 0;
                    figmaNode.bottomRightRadius = node.bottomRightRadius || 0;
                    figmaNode.bottomLeftRadius = node.bottomLeftRadius || 0;
                }
            }

            function applyEffects(figmaNode, node) {
                if (node.effects && node.effects.length > 0) {
                    figmaNode.effects = node.effects.map(function (effect) {
                        var ec = effect.color || {};
                        var eo = effect.offset || {};
                        return {
                            type: effect.type,
                            color: {
                                r: clamp(ec.r || 0),
                                g: clamp(ec.g || 0),
                                b: clamp(ec.b || 0),
                                a: ec.a !== undefined ? clamp(ec.a) : 1
                            },
                            offset: { x: eo.x || 0, y: eo.y || 0 },
                            radius: Math.max(effect.radius || 0, 0),
                            spread: effect.spread || 0,
                            visible: true
                        };
                    });
                }
            }

            function clamp(val, min = 0, max = 1) {
                return Math.min(Math.max(val, min), max);
            }

            function sanitizeFontFamily(family) {
                if (!family) return 'Inter';
                // Remove generic fallbacks and quotes
                const cleaned = family
                    .replace(/['"]/g, '')
                    .split(',')[0]
                    .trim();

                // Map common CSS system fonts to available Figma fonts
                const systemFontMap = {
                    'system-ui': 'Inter',
                    '-apple-system': 'Inter',
                    'BlinkMacSystemFont': 'Inter',
                    'Segoe UI': 'Inter',
                    'ui-sans-serif': 'Inter',
                    'ui-serif': 'Georgia',
                    'ui-monospace': 'Roboto Mono',
                    'sans-serif': 'Inter',
                    'serif': 'Georgia',
                    'monospace': 'Roboto Mono'
                };

                return systemFontMap[cleaned] || cleaned;
            }

        } catch (error) {
            console.error('Import error:', error);
            figma.notify(`❌ Import failed: ${error.message}`);
            sendProgress(`Error: ${error.message}`, 0);
        }
    }
};

function sendProgress(message, percent) {
    figma.ui.postMessage({
        type: 'progress',
        message: message,
        percent: percent
    });
}

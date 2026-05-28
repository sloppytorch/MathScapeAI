import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import React, { Component, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native';
import Svg, { Path } from 'react-native-svg';

type Mode = 'home' | 'board' | 'settings';
type LastAction = 'solve' | 'check' | 'smartScript' | null;
type DrawingTool = 'pen' | 'eraser';

type MathStep = {
  id: string;
  title: string;
  math: string;
  explanation: string;
};

type MathSolution = {
  problemStatement: string;
  finalAnswer: string;
  steps: MathStep[];
  conceptExplanation: string;
  commonMistakes: string[];
};

type Viewport = {
  offsetX: number;
  offsetY: number;
  zoom: number;
};

type WhiteboardObject = {
  id: string;
  type: 'text' | 'solutionStep' | 'feedback' | 'image';
  x: number;
  y: number;
  width: number;
  height: number;
  content?: string;
  imageUri?: string;
  metadata?: Record<string, unknown>;
};

type InkPoint = {
  x: number;
  y: number;
};

type InkStroke = {
  id: string;
  points: InkPoint[];
  color: string;
  width: number;
  refined?: boolean;
};

type CanvasSize = {
  width: number;
  height: number;
};

type BoardSnapshot = {
  objects: WhiteboardObject[];
  inkStrokes: InkStroke[];
  feedback: string;
};

type PersistedState = {
  typedProblem: string;
  imageUri?: string;
  solution: MathSolution;
  objects: WhiteboardObject[];
  inkStrokes: InkStroke[];
  feedback: string;
};

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NIM_MODEL = 'meta/llama-3.2-90b-vision-instruct';
const API_KEY_STORAGE = 'mathscape:nvidia-api-key';
const APP_STATE_STORAGE = 'mathscape:app-state:v1';
const EMPTY_VIEWPORT: Viewport = { offsetX: 0, offsetY: 0, zoom: 1 };

const SYSTEM_PROMPT = `You are MathScape AI, an expert math tutor and visual reasoning assistant.

You have three modes: SOLVE_PROBLEM, CHECK_WHITEBOARD_WORK, and CLEAN_INK.

In SOLVE_PROBLEM mode, read the image or typed math problem, solve it step by step, explain it clearly, list common mistakes, and return JSON only with this exact shape:
{"problemStatement":"...","finalAnswer":"...","steps":[{"id":"step_1","title":"Step 1","math":"...","explanation":"..."}],"conceptExplanation":"...","commonMistakes":["..."]}

In CHECK_WHITEBOARD_WORK mode, compare the user's whiteboard work against the original problem and expected solution. Identify the first incorrect or unsupported step, explain the issue, provide a corrected step, and return JSON only.

In CLEAN_INK mode, interpret rough handwritten math strokes from point paths and rewrite them as legible editable math text. Return JSON only with this shape:
{"items":[{"text":"legible math text","x":20,"y":120}]}

Return valid JSON only. Do not wrap JSON in markdown.`;

const fallbackSolution: MathSolution = {
  problemStatement: 'No AI result yet',
  finalAnswer: 'Add a problem, then tap Solve.',
  steps: [],
  conceptExplanation: '',
  commonMistakes: []
};

function extractJson(text: string) {
  const cleaned = text.trim().replace(/^```json/i, '').replace(/^```/i, '').replace(/```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('AI response could not be parsed. Try again or simplify the problem.');
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error('AI response could not be parsed. Try again or simplify the problem.');
  }
}

function solutionFromLooseText(text: string, typedProblem: string): MathSolution {
  const cleaned = text.trim();
  const answerMatch = cleaned.match(/(?:final answer|answer)\s*:?\s*([^\n]+)/i);
  return {
    problemStatement: typedProblem || 'Problem from image',
    finalAnswer: answerMatch?.[1]?.trim() || cleaned.split('\n').find(Boolean)?.trim() || 'Answer generated',
    steps: [
      {
        id: 'step_1',
        title: 'Solution',
        math: answerMatch?.[1]?.trim() || '',
        explanation: cleaned || 'The AI returned a solution, but not in the expected JSON format.'
      }
    ],
    conceptExplanation: 'This answer was recovered from a non-JSON AI response.',
    commonMistakes: []
  };
}

function friendlyError(error: unknown) {
  if (error instanceof Error) {
    if (error.message.includes('401') || error.message.includes('403')) {
      return 'NVIDIA rejected the API key. Open Settings, check the key, then retry.';
    }
    if (error.message.includes('429')) {
      return 'NVIDIA is rate limiting this key. Wait a minute, then retry.';
    }
    if (error.message.includes('Network request failed')) {
      return 'Network request failed. Check Wi-Fi or cellular, then retry.';
    }
    return error.message;
  }
  return 'Something went wrong. Try again.';
}

function normalizeSolution(parsed: any, typedProblem: string): MathSolution {
  const steps = Array.isArray(parsed.steps)
    ? parsed.steps.map((step: any, index: number) => ({
        id: String(step.id ?? `step_${index + 1}`),
        title: String(step.title ?? `Step ${index + 1}`),
        math: String(step.math ?? ''),
        explanation: String(step.explanation ?? '')
      }))
    : [];
  const finalAnswer = String(parsed.finalAnswer ?? parsed.answer ?? '');
  return {
    problemStatement: String(parsed.problemStatement ?? typedProblem ?? ''),
    finalAnswer,
    steps: steps.length
      ? steps
      : [
          {
            id: 'step_1',
            title: 'Answer',
            math: finalAnswer,
            explanation: String(parsed.explanation ?? parsed.conceptExplanation ?? 'The AI returned an answer without separate steps.')
          }
        ],
    conceptExplanation: String(parsed.conceptExplanation ?? ''),
    commonMistakes: Array.isArray(parsed.commonMistakes) ? parsed.commonMistakes.map(String) : []
  };
}

function strokeToPath(stroke: InkStroke, viewport: Viewport) {
  if (!stroke.points.length) return '';
  const [first, ...rest] = stroke.points;
  const startX = (first.x + viewport.offsetX) * viewport.zoom;
  const startY = (first.y + viewport.offsetY) * viewport.zoom;
  return rest.reduce((path, point) => {
    const x = (point.x + viewport.offsetX) * viewport.zoom;
    const y = (point.y + viewport.offsetY) * viewport.zoom;
    return `${path} L ${x} ${y}`;
  }, `M ${startX} ${startY}`);
}

function distanceBetween(a: InkPoint, b: InkPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function simplifyPoints(points: InkPoint[], minDistance = 4) {
  if (points.length <= 2) return points;
  const simplified = [points[0]];
  for (const point of points.slice(1)) {
    if (distanceBetween(point, simplified[simplified.length - 1]) >= minDistance) {
      simplified.push(point);
    }
  }
  return simplified.length > 1 ? simplified : points;
}

function smoothPoints(points: InkPoint[]) {
  if (points.length <= 3) return points;
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point;
    const previous = points[index - 1];
    const next = points[index + 1];
    return {
      x: previous.x * 0.25 + point.x * 0.5 + next.x * 0.25,
      y: previous.y * 0.25 + point.y * 0.5 + next.y * 0.25
    };
  });
}

function straightenIfTextLine(points: InkPoint[]) {
  if (points.length < 8) return points;
  const first = points[0];
  const last = points[points.length - 1];
  const width = Math.abs(last.x - first.x);
  const height = Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y));
  if (width < 36 || height > width * 0.38) return points;
  const startY = first.y;
  const endY = last.y;
  return points.map((point, index) => {
    const progress = index / Math.max(1, points.length - 1);
    const baselineY = startY + (endY - startY) * progress;
    return {
      x: point.x,
      y: baselineY + (point.y - baselineY) * 0.62
    };
  });
}

function refineStroke(stroke: InkStroke): InkStroke {
  const simplified = simplifyPoints(stroke.points);
  const smoothed = smoothPoints(simplified);
  return {
    ...stroke,
    points: straightenIfTextLine(smoothed),
    refined: true
  };
}

function scribbleLikelyErase(stroke: InkStroke) {
  if (stroke.points.length < 14) return false;
  const xs = stroke.points.map((point) => point.x);
  const ys = stroke.points.map((point) => point.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  let directionChanges = 0;
  let previousDirection = 0;
  for (let index = 1; index < stroke.points.length; index += 1) {
    const direction = Math.sign(stroke.points[index].x - stroke.points[index - 1].x);
    if (direction && previousDirection && direction !== previousDirection) {
      directionChanges += 1;
    }
    if (direction) previousDirection = direction;
  }
  return width > 28 && height < 44 && directionChanges >= 4;
}

class StartupErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <Shell>
          <View style={styles.crashPanel}>
            <Text style={styles.title}>MathScape AI</Text>
            <Text style={styles.sectionTitle}>Something crashed on startup.</Text>
            <Text style={styles.helpText}>{this.state.error.message}</Text>
            <PrimaryButton label="Try Again" onPress={() => this.setState({ error: undefined })} />
          </View>
        </Shell>
      );
    }
    return this.props.children;
  }
}

function MathScapeApp() {
  const [mode, setMode] = useState<Mode>('home');
  const [apiKey, setApiKey] = useState('');
  const [typedProblem, setTypedProblem] = useState('');
  const [imageUri, setImageUri] = useState<string | undefined>();
  const [solution, setSolution] = useState<MathSolution>(fallbackSolution);
  const [objects, setObjects] = useState<WhiteboardObject[]>([]);
  const [inkStrokes, setInkStrokes] = useState<InkStroke[]>([]);
  const [viewport, setViewport] = useState<Viewport>(EMPTY_VIEWPORT);
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 1, height: 1 });
  const [drawMode, setDrawMode] = useState(false);
  const [drawingTool, setDrawingTool] = useState<DrawingTool>('pen');
  const [smartScriptEnabled, setSmartScriptEnabled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [lastAction, setLastAction] = useState<LastAction>(null);
  const [undoStack, setUndoStack] = useState<BoardSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<BoardSnapshot[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const joystick = useRef({ dx: 0, dy: 0, active: false });
  const activeStrokeId = useRef<string | null>(null);
  const activeStrokePoints = useRef<InkPoint[]>([]);
  const smartScriptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    async function hydrate() {
      try {
        const [savedKey, savedState] = await Promise.all([
          AsyncStorage.getItem(API_KEY_STORAGE),
          AsyncStorage.getItem(APP_STATE_STORAGE)
        ]);
        if (savedKey) setApiKey(savedKey);
        if (savedState) {
          const parsed = JSON.parse(savedState) as Partial<PersistedState>;
          setTypedProblem(parsed.typedProblem ?? '');
          setImageUri(parsed.imageUri);
          setSolution(parsed.solution ?? fallbackSolution);
          setObjects(Array.isArray(parsed.objects) ? parsed.objects : []);
          setInkStrokes(Array.isArray(parsed.inkStrokes) ? parsed.inkStrokes : []);
          setFeedback(parsed.feedback ?? '');
        }
      } catch {
        setErrorMessage('Saved app state could not be loaded. You can keep working or start a new problem.');
      } finally {
        setHydrated(true);
      }
    }
    hydrate();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const state: PersistedState = { typedProblem, imageUri, solution, objects, inkStrokes, feedback };
    AsyncStorage.setItem(APP_STATE_STORAGE, JSON.stringify(state)).catch(() => {
      setErrorMessage('Could not save your latest work on this device.');
    });
  }, [feedback, hydrated, imageUri, inkStrokes, objects, solution, typedProblem]);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      if (joystick.current.active) {
        setViewport((current) => ({
          ...current,
          offsetX: current.offsetX + joystick.current.dx * 5 / current.zoom,
          offsetY: current.offsetY + joystick.current.dy * 5 / current.zoom
        }));
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    return () => {
      if (smartScriptTimer.current) {
        clearTimeout(smartScriptTimer.current);
      }
    };
  }, []);

  const snapshotBoard = useCallback((): BoardSnapshot => ({
    objects,
    inkStrokes,
    feedback
  }), [feedback, inkStrokes, objects]);

  const pushUndo = useCallback(() => {
    const snapshot = snapshotBoard();
    setUndoStack((current) => [...current.slice(-24), snapshot]);
    setRedoStack([]);
  }, [snapshotBoard]);

  const undoBoard = () => {
    setUndoStack((current) => {
      if (!current.length) return current;
      const previous = current[current.length - 1];
      setRedoStack((redo) => [...redo.slice(-24), snapshotBoard()]);
      setObjects(previous.objects);
      setInkStrokes(previous.inkStrokes);
      setFeedback(previous.feedback);
      return current.slice(0, -1);
    });
    setMenuOpen(false);
  };

  const redoBoard = () => {
    setRedoStack((current) => {
      if (!current.length) return current;
      const next = current[current.length - 1];
      setUndoStack((undo) => [...undo.slice(-24), snapshotBoard()]);
      setObjects(next.objects);
      setInkStrokes(next.inkStrokes);
      setFeedback(next.feedback);
      return current.slice(0, -1);
    });
    setMenuOpen(false);
  };

  const saveApiKey = async () => {
    const nextKey = apiKey.trim();
    await AsyncStorage.setItem(API_KEY_STORAGE, nextKey);
    setApiKey(nextKey);
    setErrorMessage('');
    Alert.alert('Saved', 'Your NVIDIA API key is saved on this device.');
  };

  const clearApiKey = async () => {
    await AsyncStorage.removeItem(API_KEY_STORAGE);
    setApiKey('');
    setErrorMessage('API key cleared. Add a key before solving or checking work.');
  };

  const resetBoard = () => {
    pushUndo();
    setObjects(buildSolutionObjects(solution, imageUri));
    setInkStrokes([]);
    setFeedback('');
    setViewport(EMPTY_VIEWPORT);
    setErrorMessage('');
    setMenuOpen(false);
  };

  const newProblem = async () => {
    setTypedProblem('');
    setImageUri(undefined);
    setSolution(fallbackSolution);
    setObjects([]);
    setInkStrokes([]);
    setFeedback('');
    setViewport(EMPTY_VIEWPORT);
    setDrawMode(false);
    setDrawingTool('pen');
    setSmartScriptEnabled(false);
    setUndoStack([]);
    setRedoStack([]);
    setMenuOpen(false);
    setErrorMessage('');
    setMode('home');
    await AsyncStorage.removeItem(APP_STATE_STORAGE);
  };

  const pickImage = async (camera: boolean) => {
    const permission = camera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      setErrorMessage('Permission is needed to use that input.');
      Alert.alert('Permission needed', 'MathScape needs permission to use this input.');
      return;
    }

    const result = camera
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.8 });

    if (!result.canceled) {
      const asset = result.assets[0];
      setImageUri(asset.base64 ? `data:image/jpeg;base64,${asset.base64}` : asset.uri);
      setErrorMessage('');
    }
  };

  const callNvidia = async (body: Record<string, unknown>) => {
    const response = await fetch(NVIDIA_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`NVIDIA request failed: ${response.status}${detail ? ` - ${detail.slice(0, 180)}` : ''}`);
    }

    return response.json();
  };

  const solveProblem = async () => {
    setLastAction('solve');
    if (!apiKey.trim()) {
      setErrorMessage('Open Settings and add your NVIDIA API key first.');
      return;
    }
    if (!typedProblem.trim() && !imageUri) {
      setErrorMessage('Type a math problem or upload an image first.');
      return;
    }

    setBusy(true);
    setFeedback('');
    setErrorMessage('');
    try {
      const content: any[] = [
        {
          type: 'text',
          text: `Mode: SOLVE_PROBLEM. Typed problem: ${typedProblem || '(none)'}. Return JSON with problemStatement, finalAnswer, steps, conceptExplanation, commonMistakes.`
        }
      ];

      if (imageUri) {
        content.push({ type: 'image_url', image_url: { url: imageUri } });
      }

      const data = await callNvidia({
        model: NIM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2048
      });
      const rawContent = data.choices?.[0]?.message?.content ?? '';
      let nextSolution: MathSolution;
      try {
        nextSolution = normalizeSolution(extractJson(rawContent), typedProblem);
      } catch {
        nextSolution = solutionFromLooseText(rawContent, typedProblem);
      }
      setSolution(nextSolution);
      pushUndo();
      setObjects(buildSolutionObjects(nextSolution, imageUri));
      setInkStrokes([]);
      setViewport(EMPTY_VIEWPORT);
      setMode('board');
    } catch (error) {
      setErrorMessage(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };

  const checkWork = async () => {
    setLastAction('check');
    if (!apiKey.trim()) {
      setErrorMessage('Open Settings and add your NVIDIA API key first.');
      return;
    }
    if (solution === fallbackSolution && objects.length === 0) {
      setErrorMessage('Solve or add work to the board before checking it.');
      return;
    }

    setBusy(true);
    setErrorMessage('');
    try {
      const data = await callNvidia({
        model: NIM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Mode: CHECK_WHITEBOARD_WORK. Return JSON only. Original problem: ${solution.problemStatement}. Expected solution: ${JSON.stringify(solution)}. Whiteboard objects: ${JSON.stringify(objects)}. Ink strokes: ${JSON.stringify(inkStrokes)}`
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 1600
      });

      const parsed = extractJson(data.choices?.[0]?.message?.content ?? '');
      const summary = String(parsed.summary ?? (parsed.isCorrect ? 'Your work looks correct.' : 'There is something to review.'));
      pushUndo();
      setFeedback(summary);
      const feedbackObjects = Array.isArray(parsed.feedbackObjects) ? parsed.feedbackObjects : [];
      setObjects((current) => [
        ...current,
        ...(feedbackObjects.length ? feedbackObjects : [{ content: summary }]).map((item: any, index: number) => ({
          id: String(item.id ?? `feedback_${Date.now()}_${index}`),
          type: 'feedback' as const,
          x: Number(item.x ?? 20),
          y: Number(item.y ?? 360 + index * 92),
          width: Number(item.width ?? 290),
          height: Number(item.height ?? 84),
          content: String(item.content ?? summary),
          metadata: item.metadata ?? { severity: parsed.isCorrect ? 'success' : 'error' }
        }))
      ]);
    } catch (error) {
      setErrorMessage(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };

  const retryLastAction = () => {
    if (lastAction === 'check') {
      checkWork();
    } else if (lastAction === 'smartScript') {
      runSmartScript();
    } else {
      solveProblem();
    }
  };

  const addText = () => {
    pushUndo();
    setObjects((current) => [
      ...current,
      {
        id: `text_${Date.now()}`,
        type: 'text',
        x: -viewport.offsetX + 40,
        y: -viewport.offsetY + 80,
        width: 280,
        height: 120,
        content: 'Write your step here'
      }
    ]);
  };

  const recognizeInkAsText = async () => {
    if (!apiKey.trim()) {
      setErrorMessage('Open Settings and add your NVIDIA API key before recognizing handwriting as text.');
      return;
    }
    if (!inkStrokes.length) {
      setErrorMessage('Draw something on the board first, then use Smart Script.');
      return;
    }

    setBusy(true);
    setErrorMessage('');
    try {
      const data = await callNvidia({
        model: NIM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Mode: CLEAN_INK. This is Smart Script. Convert rough handwritten math into legible editable math text. Return JSON only. Problem context: ${solution.problemStatement}. Strokes: ${JSON.stringify(inkStrokes)}`
          }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 900
      });
      const parsed = extractJson(data.choices?.[0]?.message?.content ?? '');
      const items = Array.isArray(parsed.items) ? parsed.items : [];
      if (!items.length) {
        throw new Error('No legible handwriting was recognized. Try writing larger or with fewer connected symbols.');
      }
      pushUndo();
      setObjects((current) => [
        ...current,
        ...items.map((item: any, index: number) => ({
          id: `clean_${Date.now()}_${index}`,
          type: 'text' as const,
          x: Number(item.x ?? 40),
          y: Number(item.y ?? 120 + index * 90),
          width: Number(item.width ?? 280),
          height: Number(item.height ?? 86),
          content: String(item.text ?? item.content ?? '')
        }))
      ]);
      setInkStrokes([]);
      setFeedback('Recognized handwriting into editable text cards.');
    } catch (error) {
      setErrorMessage(friendlyError(error));
    } finally {
      setBusy(false);
    }
  };

  const refineInk = useCallback((strokeIds?: string[]) => {
    pushUndo();
    setInkStrokes((current) =>
      current.map((stroke) =>
        !strokeIds || strokeIds.includes(stroke.id) ? refineStroke(stroke) : stroke
      )
    );
    setFeedback('Smart Script refined your handwriting while keeping it as ink.');
  }, [pushUndo]);

  const runSmartScript = useCallback((strokeId?: string) => {
    setLastAction('smartScript');
    refineInk(strokeId ? [strokeId] : undefined);
  }, [refineInk]);

  const scheduleSmartScript = (strokeId: string) => {
    if (!smartScriptEnabled) return;
    if (smartScriptTimer.current) {
      clearTimeout(smartScriptTimer.current);
    }
    smartScriptTimer.current = setTimeout(() => {
      runSmartScript(strokeId);
    }, 1300);
  };

  const eraseAtPoint = (point: InkPoint) => {
    const radius = 24 / viewport.zoom;
    setInkStrokes((current) =>
      current.filter((stroke) =>
        !stroke.points.some((strokePoint) => Math.hypot(strokePoint.x - point.x, strokePoint.y - point.y) <= radius)
      )
    );
  };

  const canvasResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => drawMode,
        onMoveShouldSetPanResponder: () => drawMode,
        onPanResponderGrant: (event) => {
          if (!drawMode) return;
          const point = {
            x: event.nativeEvent.locationX / viewport.zoom - viewport.offsetX,
            y: event.nativeEvent.locationY / viewport.zoom - viewport.offsetY
          };
          pushUndo();
          if (drawingTool === 'eraser') {
            eraseAtPoint(point);
            return;
          }
          const id = `ink_${Date.now()}`;
          activeStrokeId.current = id;
          activeStrokePoints.current = [point];
          setInkStrokes((current) => [
            ...current,
            { id, points: [point], color: '#17201b', width: 4 }
          ]);
        },
        onPanResponderMove: (event) => {
          if (!drawMode) return;
          const point = {
            x: event.nativeEvent.locationX / viewport.zoom - viewport.offsetX,
            y: event.nativeEvent.locationY / viewport.zoom - viewport.offsetY
          };
          if (drawingTool === 'eraser') {
            eraseAtPoint(point);
            return;
          }
          if (!activeStrokeId.current) return;
          activeStrokePoints.current = [...activeStrokePoints.current, point];
          setInkStrokes((current) =>
            current.map((stroke) =>
              stroke.id === activeStrokeId.current
                ? { ...stroke, points: [...stroke.points, point] }
                : stroke
            )
          );
        },
        onPanResponderRelease: () => {
          const completedStrokeId = activeStrokeId.current;
          const completedStroke = completedStrokeId
            ? { id: completedStrokeId, points: activeStrokePoints.current, color: '#17201b', width: 4 }
            : undefined;
          if (drawingTool === 'pen') {
            if (completedStroke && scribbleLikelyErase(completedStroke)) {
              setInkStrokes((current) => current.filter((stroke) => stroke.id !== completedStrokeId));
              eraseAtPoint(completedStroke.points[Math.floor(completedStroke.points.length / 2)]);
            } else if (completedStrokeId) {
              scheduleSmartScript(completedStrokeId);
            }
          }
          activeStrokeId.current = null;
          activeStrokePoints.current = [];
        }
      }),
    [drawMode, drawingTool, pushUndo, smartScriptEnabled, viewport.offsetX, viewport.offsetY, viewport.zoom]
  );

  const handleCanvasLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setCanvasSize({ width, height });
  };

  const activeQuestion = solution.problemStatement && solution.problemStatement !== fallbackSolution.problemStatement
    ? solution.problemStatement
    : typedProblem || 'No problem loaded yet. Solve a problem or add your own work.';

  const moveObject = useCallback((id: string, dx: number, dy: number) => {
    setObjects((current) =>
      current.map((object) => (object.id === id ? { ...object, x: object.x + dx, y: object.y + dy } : object))
    );
  }, []);

  const updateObjectContent = useCallback((id: string, content: string) => {
    setObjects((current) =>
      current.map((object) => (object.id === id ? { ...object, content } : object))
    );
  }, []);

  if (!hydrated) {
    return (
      <Shell>
        <LoadingOverlay label="Opening MathScape..." />
      </Shell>
    );
  }

  if (mode === 'settings') {
    return (
      <Shell>
        <Header title="Settings" onBack={() => setMode('home')} />
        <ScrollView contentContainerStyle={styles.homeContent}>
          {errorMessage ? <ErrorBanner message={errorMessage} onRetry={retryLastAction} /> : null}
          <View style={styles.panel}>
            <Text style={styles.label}>NVIDIA API Key</Text>
            <TextInput
              value={apiKey}
              onChangeText={setApiKey}
              placeholder="nvapi-..."
              secureTextEntry
              autoCapitalize="none"
              style={styles.input}
            />
            <PrimaryButton label="Save Key" onPress={saveApiKey} />
            <SecondaryButton label="Clear Key" onPress={clearApiKey} />
            <Text style={styles.helpText}>
              This prototype stores the key only on this device. For a public release, route NVIDIA calls through a backend proxy so the key is never exposed in the app.
            </Text>
          </View>
        </ScrollView>
      </Shell>
    );
  }

  if (mode === 'board') {
    return (
      <Shell>
        <View style={styles.boardHeader}>
          <Pressable onPress={() => setMode('home')} style={styles.iconButton}><Text style={styles.iconText}>Home</Text></Pressable>
          <Text style={styles.boardTitle}>Whiteboard</Text>
          <Pressable onPress={() => setMenuOpen((open) => !open)} style={styles.iconButton}><Text style={styles.iconText}>Menu</Text></Pressable>
        </View>

        <View style={styles.problemStrip}>
          <Text style={styles.problemLabel}>Question</Text>
          <Text style={styles.problemText} numberOfLines={2}>{activeQuestion}</Text>
        </View>

        <View style={styles.boardStatus}>
          <Pressable
            onPress={() => setDrawMode((enabled) => !enabled)}
            style={[styles.drawToggle, drawMode && styles.drawToggleActive]}
          >
            <Text style={[styles.drawToggleText, drawMode && styles.drawToggleTextActive]}>
              {drawMode ? 'Drawing On' : 'Drawing Off'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setDrawingTool((tool) => (tool === 'pen' ? 'eraser' : 'pen'))}
            style={[styles.toolChip, drawingTool === 'eraser' && styles.toolChipActive]}
          >
            <Text style={[styles.toolChipText, drawingTool === 'eraser' && styles.toolChipTextActive]}>
              {drawingTool === 'eraser' ? 'Eraser' : 'Pen'}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setSmartScriptEnabled((enabled) => !enabled)}
            style={[styles.toolChip, smartScriptEnabled && styles.toolChipActive]}
          >
            <Text style={[styles.toolChipText, smartScriptEnabled && styles.toolChipTextActive]}>
              Auto-refine
            </Text>
          </Pressable>
          <Text style={styles.boardHint}>{drawMode ? `${drawingTool === 'eraser' ? 'Erase ink' : 'Write with finger'}. Joystick moves the board.` : 'Joystick moves the board. Turn drawing on to write.'}</Text>
        </View>

        {menuOpen ? (
          <View style={styles.menuPanel}>
            <Tool label="Add Text" onPress={() => { addText(); setMenuOpen(false); }} />
            <Tool label="Undo" onPress={undoBoard} />
            <Tool label="Redo" onPress={redoBoard} />
            <Tool label="Refine Ink" onPress={() => { runSmartScript(); setMenuOpen(false); }} />
            <Tool label="Recognize Text" onPress={() => { recognizeInkAsText(); setMenuOpen(false); }} />
            <Tool label="Check Work" onPress={() => { checkWork(); setMenuOpen(false); }} />
            <Tool label="Reset Board" onPress={() => { resetBoard(); setMenuOpen(false); }} />
            <Tool label="New Problem" onPress={() => { newProblem(); setMenuOpen(false); }} />
            <Tool label="Settings" onPress={() => { setMode('settings'); setMenuOpen(false); }} />
            <Tool label="Center" onPress={() => { setViewport(EMPTY_VIEWPORT); setMenuOpen(false); }} />
            <Tool label="Zoom +" onPress={() => setViewport((v) => ({ ...v, zoom: Math.min(1.8, v.zoom + 0.1) }))} />
            <Tool label="Zoom -" onPress={() => setViewport((v) => ({ ...v, zoom: Math.max(0.6, v.zoom - 0.1) }))} />
          </View>
        ) : null}

        {errorMessage ? <ErrorBanner message={errorMessage} onRetry={retryLastAction} /> : null}
        {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}

        <View style={styles.canvas} onLayout={handleCanvasLayout} {...canvasResponder.panHandlers}>
          <Grid viewport={viewport} />
          <Svg width={canvasSize.width} height={canvasSize.height} style={styles.inkLayer}>
            {inkStrokes.map((stroke) => (
              <Path
                key={stroke.id}
                d={strokeToPath(stroke, viewport)}
                stroke={stroke.color}
                strokeWidth={stroke.width * viewport.zoom}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
            ))}
          </Svg>
          {objects.map((object) => (
            <BoardObject
              key={object.id}
              object={object}
              viewport={viewport}
              onMove={moveObject}
              onChangeContent={updateObjectContent}
            />
          ))}
          <Joystick joystick={joystick} />
          {busy ? <LoadingOverlay label="Thinking..." /> : null}
        </View>
      </Shell>
    );
  }

  return (
    <Shell>
      <View style={styles.hero}>
        <View>
          <Text style={styles.title}>MathScape AI</Text>
          <Text style={styles.subtitle}>Solve, explore, and check math on a spatial whiteboard.</Text>
        </View>
        <Pressable onPress={() => setMode('settings')} style={styles.settingsButton}>
          <Text style={styles.settingsText}>Key</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.homeContent}>
        {errorMessage ? <ErrorBanner message={errorMessage} onRetry={retryLastAction} /> : null}
        <View style={styles.panel}>
          <Text style={styles.label}>Type a problem</Text>
          <TextInput
            value={typedProblem}
            onChangeText={setTypedProblem}
            placeholder="Example: Solve 2x + 5 = 17"
            multiline
            style={[styles.input, styles.problemInput]}
          />
          <View style={styles.row}>
            <SecondaryButton label="Camera" onPress={() => pickImage(true)} />
            <SecondaryButton label="Upload" onPress={() => pickImage(false)} />
          </View>
          {imageUri ? <Image source={{ uri: imageUri }} style={styles.preview} /> : null}
          <PrimaryButton label={busy ? 'Solving...' : 'Solve'} onPress={solveProblem} disabled={busy} />
          <View style={styles.row}>
            <SecondaryButton label="Open Whiteboard" onPress={() => setMode('board')} />
            <SecondaryButton label="New Problem" onPress={newProblem} />
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.sectionTitle}>Latest Answer</Text>
          <Text style={styles.answer}>{solution.finalAnswer}</Text>
          {solution.steps.map((step) => (
            <View key={step.id} style={styles.stepRow}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.math}>{step.math}</Text>
              <Text style={styles.explain}>{step.explanation}</Text>
            </View>
          ))}
          {solution.conceptExplanation ? <Text style={styles.explain}>{solution.conceptExplanation}</Text> : null}
        </View>
      </ScrollView>
      {busy ? <LoadingOverlay label="Thinking..." /> : null}
    </Shell>
  );
}

export default function App() {
  return (
    <StartupErrorBoundary>
      <MathScapeApp />
    </StartupErrorBoundary>
  );
}

function buildSolutionObjects(solution: MathSolution, imageUri?: string): WhiteboardObject[] {
  const initial: WhiteboardObject[] = imageUri
    ? [{ id: 'problem_image', type: 'image', x: 20, y: 20, width: 260, height: 180, imageUri }]
    : [];

  const startY = imageUri ? 230 : 20;
  return [
    ...initial,
    {
      id: 'answer',
      type: 'solutionStep',
      x: 20,
      y: startY,
      width: 300,
      height: 120,
      content: `Answer\n${solution.finalAnswer}`
    },
    ...solution.steps.map((step, index) => ({
      id: step.id || `step_${index + 1}`,
      type: 'solutionStep' as const,
      x: 20 + (index % 2) * 330,
      y: startY + 150 + Math.floor(index / 2) * 190,
      width: 300,
      height: 165,
      content: `${step.title}\n${step.math}\n${step.explanation}`
    }))
  ];
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      {children}
    </SafeAreaView>
  );
}

function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <View style={styles.boardHeader}>
      <Pressable onPress={onBack} style={styles.iconButton}><Text style={styles.iconText}>Back</Text></Pressable>
      <Text style={styles.boardTitle}>{title}</Text>
      <View style={styles.iconButton} />
    </View>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={styles.errorBanner}>
      <Text style={styles.errorText}>{message}</Text>
      <Pressable onPress={onRetry} style={styles.retryButton}>
        <Text style={styles.retryText}>Retry</Text>
      </Pressable>
    </View>
  );
}

function PrimaryButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[styles.primaryButton, disabled && styles.disabled]}>
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.secondaryButton}>
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

function Tool({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.tool}>
      <Text style={styles.toolText}>{label}</Text>
    </Pressable>
  );
}

function Grid({ viewport }: { viewport: Viewport }) {
  const lines = [];
  for (let i = -12; i < 28; i += 1) {
    const x = ((i * 40 + viewport.offsetX * viewport.zoom) % 40 + 40) % 40;
    const y = ((i * 40 + viewport.offsetY * viewport.zoom) % 40 + 40) % 40;
    lines.push(<View key={`v${i}`} style={[styles.gridLineV, { left: x }]} />);
    lines.push(<View key={`h${i}`} style={[styles.gridLineH, { top: y }]} />);
  }
  return <>{lines}</>;
}

function BoardObject({
  object,
  viewport,
  onMove,
  onChangeContent
}: {
  object: WhiteboardObject;
  viewport: Viewport;
  onMove: (id: string, dx: number, dy: number) => void;
  onChangeContent: (id: string, content: string) => void;
}) {
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 8 || Math.abs(gesture.dy) > 8,
        onPanResponderMove: (_, gesture) => {
          onMove(object.id, gesture.vx * 6 / viewport.zoom, gesture.vy * 6 / viewport.zoom);
        }
      }),
    [object.id, onMove, viewport.zoom]
  );

  const left = (object.x + viewport.offsetX) * viewport.zoom;
  const top = (object.y + viewport.offsetY) * viewport.zoom;
  const severity = object.metadata?.severity;

  return (
    <View
      {...responder.panHandlers}
      style={[
        styles.object,
        object.type === 'feedback' && styles.feedbackObject,
        severity === 'error' && styles.errorObject,
        severity === 'success' && styles.successObject,
        {
          left,
          top,
          width: object.width * viewport.zoom,
          minHeight: object.height * viewport.zoom
        }
      ]}
    >
      {object.imageUri ? (
        <Image source={{ uri: object.imageUri }} style={styles.objectImage} resizeMode="cover" />
      ) : object.type === 'text' ? (
        <TextInput
          value={object.content ?? ''}
          onChangeText={(content) => onChangeContent(object.id, content)}
          multiline
          style={styles.objectInput}
        />
      ) : (
        <Text style={styles.objectText}>{object.content}</Text>
      )}
    </View>
  );
}

function Joystick({ joystick }: { joystick: React.MutableRefObject<{ dx: number; dy: number; active: boolean }> }) {
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          joystick.current.active = true;
        },
        onPanResponderMove: (_, gesture) => {
          const radius = 42;
          const distance = Math.min(radius, Math.hypot(gesture.dx, gesture.dy));
          const angle = Math.atan2(gesture.dy, gesture.dx);
          const x = Math.cos(angle) * distance;
          const y = Math.sin(angle) * distance;
          joystick.current.dx = x / radius;
          joystick.current.dy = y / radius;
          setKnob({ x, y });
        },
        onPanResponderRelease: () => {
          joystick.current = { dx: 0, dy: 0, active: false };
          setKnob({ x: 0, y: 0 });
        }
      }),
    [joystick]
  );

  return (
    <View style={styles.joystickBase} {...responder.panHandlers}>
      <View style={[styles.joystickKnob, { transform: [{ translateX: knob.x }, { translateY: knob.y }] }]} />
    </View>
  );
}

function LoadingOverlay({ label }: { label: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="large" color="#f7f3ea" />
      <Text style={styles.loadingText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#f7f3ea'
  },
  hero: {
    padding: 20,
    paddingTop: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    color: '#17201b'
  },
  subtitle: {
    marginTop: 6,
    maxWidth: 270,
    fontSize: 15,
    color: '#51615a'
  },
  settingsButton: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#17201b'
  },
  settingsText: {
    color: '#f7f3ea',
    fontWeight: '700'
  },
  homeContent: {
    padding: 16,
    paddingBottom: 36,
    gap: 16
  },
  panel: {
    borderWidth: 1,
    borderColor: '#d8d0c0',
    backgroundColor: '#fffaf0',
    borderRadius: 8,
    padding: 16,
    gap: 12
  },
  crashPanel: {
    flex: 1,
    justifyContent: 'center',
    padding: 18,
    gap: 14
  },
  errorBanner: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#c64545',
    backgroundColor: '#fff0f0',
    padding: 12,
    gap: 10
  },
  errorText: {
    color: '#7a2525',
    fontWeight: '700',
    lineHeight: 20
  },
  retryButton: {
    alignSelf: 'flex-start',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: '#7a2525'
  },
  retryText: {
    color: '#fff',
    fontWeight: '800'
  },
  label: {
    fontSize: 14,
    color: '#405047',
    fontWeight: '700'
  },
  input: {
    borderWidth: 1,
    borderColor: '#c9bfad',
    borderRadius: 8,
    backgroundColor: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: '#17201b'
  },
  problemInput: {
    minHeight: 96,
    textAlignVertical: 'top'
  },
  row: {
    flexDirection: 'row',
    gap: 10
  },
  preview: {
    width: '100%',
    height: 180,
    borderRadius: 8,
    backgroundColor: '#ddd'
  },
  primaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 50,
    borderRadius: 8,
    backgroundColor: '#0f6b5f'
  },
  primaryText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 16
  },
  secondaryButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 46,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0f6b5f',
    backgroundColor: '#f7fffb'
  },
  secondaryText: {
    color: '#0f6b5f',
    fontWeight: '800'
  },
  disabled: {
    opacity: 0.55
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#17201b'
  },
  answer: {
    fontSize: 18,
    color: '#0f6b5f',
    fontWeight: '800'
  },
  stepRow: {
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#e5ddcf',
    gap: 4
  },
  stepTitle: {
    fontWeight: '800',
    color: '#17201b'
  },
  math: {
    fontFamily: 'Courier',
    color: '#21332c'
  },
  explain: {
    color: '#51615a',
    lineHeight: 20
  },
  helpText: {
    color: '#65736d',
    lineHeight: 20
  },
  boardHeader: {
    height: 54,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: '#d8d0c0'
  },
  boardTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: '#17201b'
  },
  iconButton: {
    width: 70,
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#ece4d6'
  },
  iconText: {
    color: '#17201b',
    fontWeight: '800'
  },
  problemStrip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#d8d0c0',
    backgroundColor: '#fffaf0',
    gap: 2
  },
  problemLabel: {
    fontSize: 12,
    fontWeight: '900',
    color: '#0f6b5f',
    textTransform: 'uppercase'
  },
  problemText: {
    color: '#17201b',
    fontWeight: '800',
    lineHeight: 20
  },
  boardStatus: {
    minHeight: 48,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#d8d0c0',
    backgroundColor: '#fbf8ef'
  },
  boardHint: {
    flex: 1,
    color: '#51615a',
    fontSize: 12,
    fontWeight: '700'
  },
  toolChip: {
    minHeight: 34,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#9a8f7f',
    backgroundColor: '#fffaf0'
  },
  toolChipActive: {
    borderColor: '#0f6b5f',
    backgroundColor: '#0f6b5f'
  },
  toolChipText: {
    color: '#17201b',
    fontSize: 12,
    fontWeight: '900'
  },
  toolChipTextActive: {
    color: '#fff'
  },
  drawToggle: {
    minHeight: 34,
    minWidth: 108,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#0f6b5f',
    backgroundColor: '#f7fffb'
  },
  drawToggleActive: {
    backgroundColor: '#0f6b5f'
  },
  drawToggleText: {
    color: '#0f6b5f',
    fontSize: 12,
    fontWeight: '900'
  },
  drawToggleTextActive: {
    color: '#fff'
  },
  menuPanel: {
    padding: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#d8d0c0',
    backgroundColor: '#ece4d6'
  },
  tool: {
    minHeight: 36,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: '#17201b'
  },
  toolText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800'
  },
  feedback: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#fff4c2',
    color: '#4a3b00',
    fontWeight: '700'
  },
  canvas: {
    flex: 1,
    overflow: 'hidden',
    backgroundColor: '#fbf8ef'
  },
  inkLayer: {
    position: 'absolute',
    left: 0,
    top: 0
  },
  gridLineV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 1,
    backgroundColor: '#e6dece'
  },
  gridLineH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: '#e6dece'
  },
  object: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: '#c6baa7',
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#fff',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 }
  },
  feedbackObject: {
    backgroundColor: '#fff8d8',
    borderColor: '#c99613'
  },
  errorObject: {
    backgroundColor: '#fff0f0',
    borderColor: '#c64545'
  },
  successObject: {
    backgroundColor: '#effbf3',
    borderColor: '#1d8f52'
  },
  objectText: {
    color: '#17201b',
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '600'
  },
  objectInput: {
    minHeight: 92,
    color: '#17201b',
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '600',
    padding: 0,
    textAlignVertical: 'top'
  },
  objectImage: {
    width: '100%',
    height: 150,
    borderRadius: 6
  },
  joystickBase: {
    position: 'absolute',
    left: 24,
    bottom: 28,
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: 'rgba(23,32,27,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(23,32,27,0.24)'
  },
  joystickKnob: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#0f6b5f'
  },
  loading: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(23,32,27,0.72)',
    gap: 12
  },
  loadingText: {
    color: '#f7f3ea',
    fontWeight: '800'
  }
});

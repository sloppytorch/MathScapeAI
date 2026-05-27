import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
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

type Mode = 'home' | 'board' | 'settings';

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

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const NIM_MODEL = 'meta/llama-3.2-90b-vision-instruct';
const API_KEY_STORAGE = 'mathscape:nvidia-api-key';

const SYSTEM_PROMPT = `You are MathScape AI, an expert math tutor and visual reasoning assistant.

You have two modes: SOLVE_PROBLEM and CHECK_WHITEBOARD_WORK.

In SOLVE_PROBLEM mode, read the image or typed math problem, solve it step by step, explain it clearly, list common mistakes, and return JSON only.

In CHECK_WHITEBOARD_WORK mode, compare the user's whiteboard work against the original problem and expected solution. Identify the first incorrect or unsupported step, explain the issue, provide a corrected step, and return JSON only.

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
    throw new Error('The AI did not return JSON.');
  }
  return JSON.parse(cleaned.slice(start, end + 1));
}

export default function App() {
  const [mode, setMode] = useState<Mode>('home');
  const [apiKey, setApiKey] = useState('');
  const [typedProblem, setTypedProblem] = useState('');
  const [imageUri, setImageUri] = useState<string | undefined>();
  const [solution, setSolution] = useState<MathSolution>(fallbackSolution);
  const [objects, setObjects] = useState<WhiteboardObject[]>([]);
  const [viewport, setViewport] = useState<Viewport>({ offsetX: 0, offsetY: 0, zoom: 1 });
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const joystick = useRef({ dx: 0, dy: 0, active: false });

  useEffect(() => {
    AsyncStorage.getItem(API_KEY_STORAGE).then((saved) => {
      if (saved) setApiKey(saved);
    });
  }, []);

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

  const saveApiKey = async () => {
    await AsyncStorage.setItem(API_KEY_STORAGE, apiKey.trim());
    Alert.alert('Saved', 'Your NVIDIA API key is saved on this device.');
  };

  const pickImage = async (camera: boolean) => {
    const permission = camera
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (!permission.granted) {
      Alert.alert('Permission needed', 'MathScape needs permission to use this input.');
      return;
    }

    const result = camera
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.8 })
      : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.8 });

    if (!result.canceled) {
      const asset = result.assets[0];
      setImageUri(asset.base64 ? `data:image/jpeg;base64,${asset.base64}` : asset.uri);
    }
  };

  const solveProblem = async () => {
    if (!apiKey.trim()) {
      Alert.alert('API key needed', 'Open Settings and add your NVIDIA API key first.');
      return;
    }
    if (!typedProblem.trim() && !imageUri) {
      Alert.alert('Add a problem', 'Type a math problem or upload an image.');
      return;
    }

    setBusy(true);
    setFeedback('');
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

      const response = await fetch(NVIDIA_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: NIM_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content }
          ],
          temperature: 0.2,
          max_tokens: 2048
        })
      });

      if (!response.ok) {
        throw new Error(`NVIDIA request failed: ${response.status}`);
      }

      const data = await response.json();
      const parsed = extractJson(data.choices?.[0]?.message?.content ?? '');
      const nextSolution: MathSolution = {
        problemStatement: parsed.problemStatement ?? typedProblem,
        finalAnswer: parsed.finalAnswer ?? '',
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
        conceptExplanation: parsed.conceptExplanation ?? '',
        commonMistakes: Array.isArray(parsed.commonMistakes) ? parsed.commonMistakes : []
      };
      setSolution(nextSolution);
      setObjects(buildSolutionObjects(nextSolution, imageUri));
      setMode('board');
    } catch (error) {
      Alert.alert('Solve failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const checkWork = async () => {
    if (!apiKey.trim()) {
      Alert.alert('API key needed', 'Open Settings and add your NVIDIA API key first.');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(NVIDIA_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: NIM_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Mode: CHECK_WHITEBOARD_WORK. Return JSON only. Original problem: ${solution.problemStatement}. Expected solution: ${JSON.stringify(solution)}. Whiteboard objects: ${JSON.stringify(objects)}`
            }
          ],
          temperature: 0.1,
          max_tokens: 1600
        })
      });

      if (!response.ok) {
        throw new Error(`NVIDIA request failed: ${response.status}`);
      }

      const data = await response.json();
      const parsed = extractJson(data.choices?.[0]?.message?.content ?? '');
      const summary = parsed.summary ?? (parsed.isCorrect ? 'Your work looks correct.' : 'There is something to review.');
      setFeedback(summary);
      const feedbackObjects = Array.isArray(parsed.feedbackObjects) ? parsed.feedbackObjects : [];
      setObjects((current) => [
        ...current,
        ...feedbackObjects.map((item: any, index: number) => ({
          id: item.id ?? `feedback_${Date.now()}_${index}`,
          type: 'feedback' as const,
          x: Number(item.x ?? 20),
          y: Number(item.y ?? 360 + index * 88),
          width: 280,
          height: 76,
          content: item.content ?? summary,
          metadata: item.metadata ?? { severity: parsed.isCorrect ? 'success' : 'error' }
        }))
      ]);
    } catch (error) {
      Alert.alert('Check failed', error instanceof Error ? error.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const addText = () => {
    setObjects((current) => [
      ...current,
      {
        id: `text_${Date.now()}`,
        type: 'text',
        x: -viewport.offsetX + 40,
        y: -viewport.offsetY + 80,
        width: 260,
        height: 120,
        content: 'Write your step here'
      }
    ]);
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 5 || Math.abs(gesture.dy) > 5,
        onPanResponderMove: (_, gesture) => {
          setViewport((current) => ({
            ...current,
            offsetX: current.offsetX + gesture.vx * 4,
            offsetY: current.offsetY + gesture.vy * 4
          }));
        }
      }),
    []
  );

  const moveObject = useCallback((id: string, dx: number, dy: number) => {
    setObjects((current) =>
      current.map((object) => object.id === id ? { ...object, x: object.x + dx, y: object.y + dy } : object)
    );
  }, []);

  if (mode === 'settings') {
    return (
      <Shell>
        <Header title="Settings" onBack={() => setMode('home')} />
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
          <Text style={styles.helpText}>
            For a production release, route NVIDIA requests through your own backend so the key is never shipped in the app.
          </Text>
        </View>
      </Shell>
    );
  }

  if (mode === 'board') {
    return (
      <Shell>
        <View style={styles.boardHeader}>
          <Pressable onPress={() => setMode('home')} style={styles.iconButton}><Text style={styles.iconText}>Home</Text></Pressable>
          <Text style={styles.boardTitle}>Whiteboard</Text>
          <Pressable onPress={() => setMode('settings')} style={styles.iconButton}><Text style={styles.iconText}>Key</Text></Pressable>
        </View>

        <View style={styles.toolbar}>
          <Tool label="Text" onPress={addText} />
          <Tool label="Check Work" onPress={checkWork} />
          <Tool label="Reset" onPress={() => setViewport({ offsetX: 0, offsetY: 0, zoom: 1 })} />
          <Tool label="+" onPress={() => setViewport((v) => ({ ...v, zoom: Math.min(1.8, v.zoom + 0.1) }))} />
          <Tool label="-" onPress={() => setViewport((v) => ({ ...v, zoom: Math.max(0.6, v.zoom - 0.1) }))} />
        </View>

        {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}

        <View style={styles.canvas} {...panResponder.panHandlers}>
          <Grid viewport={viewport} />
          {objects.map((object) => (
            <BoardObject key={object.id} object={object} viewport={viewport} onMove={moveObject} />
          ))}
          <Joystick joystick={joystick} />
          {busy ? <LoadingOverlay /> : null}
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
          <SecondaryButton label="Open Whiteboard" onPress={() => setMode('board')} />
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
        </View>
      </ScrollView>
      {busy ? <LoadingOverlay /> : null}
    </Shell>
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

function Shell({ children }: { children: React.ReactNode }) {
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
  onMove
}: {
  object: WhiteboardObject;
  viewport: Viewport;
  onMove: (id: string, dx: number, dy: number) => void;
}) {
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: () => true,
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

function LoadingOverlay() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="large" color="#f7f3ea" />
      <Text style={styles.loadingText}>Thinking...</Text>
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
  toolbar: {
    minHeight: 54,
    paddingHorizontal: 8,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#d8d0c0'
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

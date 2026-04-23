import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Plus, 
  Play, 
  Download, 
  Square, 
  Volume2, 
  Music, 
  Settings2, 
  MonitorPlay,
  CheckCircle2,
  AlertCircle,
  Video,
  GripVertical,
  ChevronRight,
  Maximize,
  Smartphone,
  Undo2,
  Redo2,
  Scissors,
  Layers,
  Camera,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---
interface VideoFile {
  id: string;
  file: File;
  url: string;
  duration: number;
  width: number;
  height: number;
  trim: { start: number; end: number };
  filters: {
    brightness: number;
    contrast: number;
    saturation: number;
  };
}

interface AudioInfo {
  name: string;
  buffer: AudioBuffer | null;
}

interface TextOverlay {
  id: string;
  text: string;
  size: number;
  color: string;
  font: string;
  x: number;
  y: number;
}

type AudioSourceType = 'v1' | 'v2' | 'both' | 'custom' | 'mute';
type TransitionType = 'none' | 'fade' | 'slide-left' | 'slide-right' | 'zoom' | 'wipe-left' | 'wipe-right' | 'dissolve';
type OutputFormat = 'horizontal' | 'vertical' | 'square';
type SizingMode = 'cover' | 'contain';

interface AppState {
  vid1: VideoFile | null;
  vid2: VideoFile | null;
  transition: { type: TransitionType; duration: number };
  audioSource: AudioSourceType;
  mix: {
    volume: number;
    bass: number;
    mid: number;
    treble: number;
    speed: number;
    ducking: boolean;
  };
  format: OutputFormat;
  sizingMode: SizingMode;
  textOverlays: TextOverlay[];
  viewport: { zoom: number; x: number; y: number };
}

// --- Utils ---
const formatDuration = (s: number) => {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

const formatSize = (b: number) => {
  return b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
};

export default function App() {
  // --- Refs ---
  const v1Ref = useRef<HTMLVideoElement>(null);
  const v2Ref = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  
  // Audio Context & Nodes
  const acRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<{
    bass: BiquadFilterNode;
    mid: BiquadFilterNode;
    treble: BiquadFilterNode;
    gain: GainNode;
    analyser: AnalyserNode;
    duckGain: GainNode; // For background music
    videoAnalyser: AnalyserNode; // For detecting voice levels
    dest: MediaStreamAudioDestinationNode;
    src1?: MediaElementAudioSourceNode;
    src2?: MediaElementAudioSourceNode;
    custom?: AudioBufferSourceNode;
  } | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafIdRef = useRef<number | null>(null);

  // --- State ---
  const [vid1, setVid1] = useState<VideoFile | null>(null);
  const [vid2, setVid2] = useState<VideoFile | null>(null);
  const [transition, setTransition] = useState<{ type: TransitionType; duration: number }>({ type: 'none', duration: 1 });
  const [audioSource, setAudioSource] = useState<AudioSourceType>('v1');
  const [customAudio, setCustomAudio] = useState<AudioInfo | null>(null);
  const [format, setFormat] = useState<OutputFormat>('vertical');
  const [sizingMode, setSizingMode] = useState<SizingMode>('cover');
  
  // Mixers
  const [mix, setMix] = useState({
    volume: 100,
    bass: 0,
    mid: 0,
    treble: 0,
    speed: 100,
    ducking: false
  });

  const [textOverlays, setTextOverlays] = useState<TextOverlay[]>([]);
  const [viewport, setViewport] = useState({ zoom: 1, x: 0, y: 0 });

  // History for Undo/Redo
  const [history, setHistory] = useState<AppState[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const [isRunning, setIsRunning] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isTranscoding, setIsTranscoding] = useState(false);
  const [status, setStatus] = useState('Load two videos to get started');
  const [progress, setProgress] = useState({ pct: 0, label: '' });
  const [currentPlayIndex, setCurrentPlayIndex] = useState<number | null>(null);
  const [vizData, setVizData] = useState<Uint8Array>(new Uint8Array(0));

  const [showExportModal, setShowExportModal] = useState(false);
  const [exportConfig, setExportConfig] = useState({
    bitrate: 4000,
    fps: 30,
    scale: 1.0
  });

  // --- History Management ---
  const saveHistory = useCallback((newState: Partial<AppState>) => {
    setHistory(prev => {
      const entry: AppState = {
        vid1: newState.vid1 !== undefined ? newState.vid1 : vid1,
        vid2: newState.vid2 !== undefined ? newState.vid2 : vid2,
        transition: newState.transition !== undefined ? newState.transition : transition,
        audioSource: newState.audioSource !== undefined ? newState.audioSource : audioSource,
        mix: newState.mix !== undefined ? newState.mix : mix,
        format: newState.format !== undefined ? newState.format : format,
        sizingMode: newState.sizingMode !== undefined ? newState.sizingMode : sizingMode,
        textOverlays: newState.textOverlays !== undefined ? newState.textOverlays : textOverlays,
        viewport: newState.viewport !== undefined ? newState.viewport : viewport,
      };

      if (prev.length > 0 && JSON.stringify(prev[historyIndex]) === JSON.stringify(entry)) {
        return prev;
      }

      const nextHistory = prev.slice(0, historyIndex + 1);
      nextHistory.push(entry);
      if (nextHistory.length > 50) nextHistory.shift();
      setHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });
  }, [vid1, vid2, transition, audioSource, mix, format, historyIndex]);

  const undo = () => {
    if (historyIndex <= 0) return;
    const prev = history[historyIndex - 1];
    setVid1(prev.vid1);
    setVid2(prev.vid2);
    setTransition(prev.transition);
    setAudioSource(prev.audioSource);
    setMix(prev.mix);
    setFormat(prev.format);
    setSizingMode(prev.sizingMode);
    setHistoryIndex(historyIndex - 1);
  };

  const redo = () => {
    if (historyIndex >= history.length - 1) return;
    const next = history[historyIndex + 1];
    setVid1(next.vid1);
    setVid2(next.vid2);
    setTransition(next.transition);
    setAudioSource(next.audioSource);
    setMix(next.mix);
    setFormat(next.format);
    setSizingMode(next.sizingMode);
    setHistoryIndex(historyIndex + 1);
  };

  // --- Audio Engine Initialization ---
  const initAudio = useCallback(() => {
    if (acRef.current) return;
    
    // @ts-ignore
    const AC = new (window.AudioContext || window.webkitAudioContext)();
    acRef.current = AC;

    const bass = AC.createBiquadFilter(); bass.type = 'lowshelf'; bass.frequency.value = 200;
    const mid = AC.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 1;
    const treble = AC.createBiquadFilter(); treble.type = 'highshelf'; treble.frequency.value = 3000;
    const gain = AC.createGain();
    const analyser = AC.createAnalyser();
    analyser.fftSize = 128;
    const dest = AC.createMediaStreamDestination();

    const duckGain = AC.createGain();
    const videoAnalyser = AC.createAnalyser();
    videoAnalyser.fftSize = 256;

    // Routing: 
    // Video (src1/src2) -> videoAnalyser -> bass -> ... -> gain -> analyser -> dest
    // Custom -> duckGain -> bass -> ... -> gain -> analyser -> dest

    bass.connect(mid);
    mid.connect(treble);
    treble.connect(gain);
    gain.connect(analyser); // Connect gain to analyser
    analyser.connect(AC.destination);
    analyser.connect(dest);

    nodesRef.current = { bass, mid, treble, gain, analyser, duckGain, videoAnalyser, dest };
    
    // Start visualizer and ducking loop
    const updateViz = () => {
      const nodes = nodesRef.current;
      if (nodes?.analyser) {
        const dataArray = new Uint8Array(nodes.analyser.frequencyBinCount);
        nodes.analyser.getByteFrequencyData(dataArray);
        setVizData(dataArray);

        // Ducking Logic
        if (mix.ducking && nodes.videoAnalyser) {
          const vData = new Uint8Array(nodes.videoAnalyser.frequencyBinCount);
          nodes.videoAnalyser.getByteFrequencyData(vData);
          const avg = vData.reduce((a, b) => a + b, 0) / vData.length;
          const targetGain = avg > 20 ? 0.2 : 1.0; // Lower custom audio if video audio > threshold
          nodes.duckGain.gain.setTargetAtTime(targetGain, AC.currentTime, 0.1);
        } else if (nodes.duckGain) {
          nodes.duckGain.gain.setTargetAtTime(1.0, AC.currentTime, 0.1);
        }
      }
      requestAnimationFrame(updateViz);
    };
    updateViz();
    
    // Apply initial state
    bass.gain.value = mix.bass;
    mid.gain.value = mix.mid;
    treble.gain.value = mix.treble;
    gain.gain.value = mix.volume / 100;
  }, [mix]);

  // Sync EQ values
  useEffect(() => {
    if (!nodesRef.current) return;
    nodesRef.current.bass.gain.value = mix.bass;
    nodesRef.current.mid.gain.value = mix.mid;
    nodesRef.current.treble.gain.value = mix.treble;
    nodesRef.current.gain.gain.value = mix.volume / 100;
  }, [mix.bass, mix.mid, mix.treble, mix.volume]);

  // Sync speed
  useEffect(() => {
    const spd = mix.speed / 100;
    if (v1Ref.current) v1Ref.current.playbackRate = spd;
    if (v2Ref.current) v2Ref.current.playbackRate = spd;
  }, [mix.speed]);

  // --- Handlers ---
  const handleLoadVideo = (n: 1 | 2, file: File) => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.src = url;
    v.onloadedmetadata = () => {
      const data: VideoFile = {
        id: Math.random().toString(36).substr(2,9),
        file,
        url,
        duration: v.duration,
        width: v.videoWidth,
        height: v.videoHeight,
        trim: { start: 0, end: v.duration },
        filters: { brightness: 100, contrast: 100, saturation: 100 }
      };
      if (n === 1) {
        setVid1(data);
        saveHistory({ vid1: data });
      } else {
        setVid2(data);
        saveHistory({ vid2: data });
      }
      setStatus('Video added to timeline.');
    };
  };

  const handleLoadAudio = async (file: File) => {
    if (!file) return;
    initAudio();
    const ab = await file.arrayBuffer();
    try {
      const buffer = await acRef.current!.decodeAudioData(ab);
      setCustomAudio({ name: file.name, buffer });
      setStatus('Custom audio track loaded');
    } catch (e) {
      console.error(e);
      setStatus('Failed to decode audio file');
    }
  };

  // --- Master Rendering Loop ---
  const drawFrame = (v1: HTMLVideoElement | null, v2: HTMLVideoElement | null, opacity1 = 1, opacity2 = 0, offset2 = 0) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const cw = canvas.width;
    const ch = canvas.height;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    const drawVid = (vid: HTMLVideoElement | null, opacity: number, xOffset = 0) => {
      if (!vid || opacity <= 0) return;
      ctx.globalAlpha = opacity;
      
      const vw = vid.videoWidth;
      const vh = vid.videoHeight;
      const videoRatio = vw / vh;
      const canvasRatio = cw / ch;

      let drawW, drawH, drawX, drawY;

      if (sizingMode === 'cover') {
        if (videoRatio > canvasRatio) {
          drawH = ch;
          drawW = ch * videoRatio;
          drawX = (cw - drawW) / 2;
          drawY = 0;
        } else {
          drawW = cw;
          drawH = cw / videoRatio;
          drawX = 0;
          drawY = (ch - drawH) / 2;
        }
      } else {
        // Contain
        if (videoRatio > canvasRatio) {
          drawW = cw;
          drawH = cw / videoRatio;
          drawX = 0;
          drawY = (ch - drawH) / 2;
        } else {
          drawH = ch;
          drawW = ch * videoRatio;
          drawX = (cw - drawW) / 2;
          drawY = 0;
        }
      }

      // Apply filters
      const videoId = vid.getAttribute('data-vid-id');
      const videoData = videoId === 'v1' ? vid1 : vid2;
      if (videoData) {
        ctx.filter = `brightness(${videoData.filters.brightness}%) contrast(${videoData.filters.contrast}%) saturate(${videoData.filters.saturation}%)`;
      }

      ctx.drawImage(vid, drawX + xOffset, drawY, drawW, drawH);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
    };

    // Apply Viewport Zoom & Pan
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.scale(viewport.zoom, viewport.zoom);
    ctx.translate(-cw / 2 + viewport.x, -ch / 2 + viewport.y);

    if (transition.type === 'fade' || transition.type === 'dissolve') {
      drawVid(v1, opacity1);
      drawVid(v2, opacity2);
    } else if (transition.type === 'slide-left') {
      drawVid(v1, 1, -offset2 * cw);
      drawVid(v2, 1, (1 - offset2) * cw);
    } else if (transition.type === 'slide-right') {
      drawVid(v1, 1, offset2 * cw);
      drawVid(v2, 1, -(1 - offset2) * cw);
    } else if (transition.type === 'wipe-left') {
      // Manual clip for wipe
      drawVid(v1, 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect((1 - offset2) * cw, 0, offset2 * cw, ch);
      ctx.clip();
      drawVid(v2, 1);
      ctx.restore();
    } else if (transition.type === 'wipe-right') {
      drawVid(v1, 1);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, offset2 * cw, ch);
      ctx.clip();
      drawVid(v2, 1);
      ctx.restore();
    } else if (transition.type === 'zoom') {
      if (opacity1 > 0.5) drawVid(v1, opacity1);
      else drawVid(v2, opacity2);
    } else {
      drawVid(v1, 1);
    }

    ctx.restore(); // End Viewport

    // Render Text Overlays
    textOverlays.forEach(overlay => {
      ctx.fillStyle = overlay.color;
      ctx.font = `${overlay.size}px ${overlay.font}`;
      ctx.textAlign = 'center';
      ctx.fillText(overlay.text, (overlay.x / 100) * cw, (overlay.y / 100) * ch);
    });
  };

  const stopDrawing = () => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  };

  // --- Audio Routing ---
  const disconnectAll = () => {
    const nodes = nodesRef.current;
    if (!nodes) return;
    try { nodes.src1?.disconnect(); } catch (e) {}
    try { nodes.src2?.disconnect(); } catch (e) {}
    if (nodes.custom) {
      try { nodes.custom.stop(); nodes.custom.disconnect(); } catch (e) {}
      nodes.custom = undefined;
    }
  };

  const connectAudio = (phase: 'p1' | 'p2') => {
    initAudio();
    disconnectAll();
    const AC = acRef.current!;
    const nodes = nodesRef.current!;
    const type = audioSource;

    if (type === 'mute') return;

    if (type === 'custom') {
      if (!customAudio?.buffer) return;
      const src = AC.createBufferSource();
      src.buffer = customAudio.buffer;
      src.loop = true;
      src.playbackRate.value = mix.speed / 100;
      src.connect(nodes.duckGain);
      nodes.duckGain.connect(nodes.bass);
      src.start();
      nodes.custom = src;
      return;
    }

    if (type === 'v1' || (type === 'both' && phase === 'p1')) {
      if (!nodes.src1 && v1Ref.current) nodes.src1 = AC.createMediaElementSource(v1Ref.current);
      nodes.src1?.connect(nodes.videoAnalyser);
      nodes.videoAnalyser.connect(nodes.bass);
    }

    if (type === 'v2' || (type === 'both' && phase === 'p2')) {
      if (!nodes.src2 && v2Ref.current) nodes.src2 = AC.createMediaElementSource(v2Ref.current);
      nodes.src2?.connect(nodes.videoAnalyser);
      nodes.videoAnalyser.connect(nodes.bass);
    }
  };

  // --- Core Lifecycle ---
  const runSequence = async (exportMode = false, scale = 1.0) => {
    if (!vid1 || !vid2 || !v1Ref.current || !v2Ref.current || !canvasRef.current) return;
    
    setIsRunning(true);
    if (acRef.current?.state === 'suspended') await acRef.current.resume();

    const canvas = canvasRef.current;
    const spd = mix.speed / 100;
    const transDur = transition.duration;

    // Set Dimensions based on Format and Scale
    if (format === 'vertical') {
      canvas.width = 1080 * scale;
      canvas.height = 1920 * scale;
    } else if (format === 'square') {
      canvas.width = 1080 * scale;
      canvas.height = 1080 * scale;
    } else {
      canvas.width = vid1.width * scale;
      canvas.height = vid1.height * scale;
    }

    const playClip = async (idx: 1|2, start: number, end: number) => {
      const vid = idx === 1 ? v1Ref.current! : v2Ref.current!;
      vid.currentTime = start;
      vid.playbackRate = spd;
      connectAudio(idx === 1 ? 'p1' : 'p2');
      setCurrentPlayIndex(idx);
      await vid.play();

      return new Promise<void>((res) => {
        const check = () => {
          if (!isRunning) { res(); return; }
          const cur = vid.currentTime;
          
          // Handle progress
          const totalDur = (vid1.trim.end - vid1.trim.start) + (vid2.trim.end - vid2.trim.start);
          const elapsed = idx === 1 ? (cur - vid1.trim.start) : (vid1.trim.end - vid1.trim.start) + (cur - vid2.trim.start);
          setProgress({ pct: Math.round((elapsed / totalDur) * 100), label: `Clip ${idx}` });

          if (cur >= end) {
            vid.pause();
            res();
          } else {
            // Handle Transition zone
            if (idx === 1 && cur >= (end - transDur) && transition.type !== 'none') {
              // Start v2 in background
              if (v2Ref.current!.paused) {
                v2Ref.current!.currentTime = vid2.trim.start;
                v2Ref.current!.play();
              }
              const progress = (cur - (end - transDur)) / transDur;
              drawFrame(v1Ref.current, v2Ref.current, 1 - progress, progress, progress);
            } else {
              drawFrame(idx === 1 ? v1Ref.current : null, idx === 2 ? v2Ref.current : null, idx === 1 ? 1 : 0, idx === 2 ? 1 : 0);
            }
            rafIdRef.current = requestAnimationFrame(check);
          }
        };
        rafIdRef.current = requestAnimationFrame(check);
      });
    };

    try {
      setStatus('Starting Studio Render...');
      await playClip(1, vid1.trim.start, vid1.trim.end);
      if (isRunning) {
        await playClip(2, vid2.trim.start, vid2.trim.end);
      }
      setStatus('Render Finished');
      setProgress({ pct: 100, label: 'Complete' });
    } catch (err) {
      console.error(err);
      setStatus('Sequence Error');
    } finally {
      setIsRunning(false);
      setCurrentPlayIndex(null);
      disconnectAll();
    }
  };

  const handlePreview = () => {
    runSequence(false);
  };

  const handleExport = async () => {
    setShowExportModal(false);
    initAudio();
    if (!canvasRef.current || !nodesRef.current) return;
    
    setIsExporting(true);
    chunksRef.current = [];

    const stream = canvasRef.current.captureStream(exportConfig.fps);
    if (audioSource !== 'mute') {
      const aTrack = nodesRef.current.dest.stream.getAudioTracks()[0];
      if (aTrack) stream.addTrack(aTrack);
    }

    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m)) || '';

    const recorder = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond: exportConfig.bitrate * 1000
    });
    recorderRef.current = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      setStatus('Rendering complete. Converting to MP4...');
      setIsTranscoding(true);
      
      const webmBlob = new Blob(chunksRef.current, { type: 'video/webm' });
      
      // Send to server for MP4 conversion
      const formData = new FormData();
      formData.append('video', webmBlob, 'input.webm');
      formData.append('bitrate', exportConfig.bitrate.toString());
      formData.append('fps', exportConfig.fps.toString());

      try {
        const response = await fetch('/api/transcode', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) throw new Error('Transcoding failed');

        const mp4Blob = await response.blob();
        const url = URL.createObjectURL(mp4Blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `StudioMerge_${Date.now()}.mp4`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setStatus('MP4 Exported! Ready for TikTok/Instagram.');
      } catch (err) {
        console.error(err);
        setStatus('Failed to convert to MP4. Using WebM fallback.');
        const url = URL.createObjectURL(webmBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `StudioMerge_${Date.now()}.webm`;
        document.body.appendChild(a); a.click(); a.remove();
      } finally {
        setIsExporting(false);
        setIsTranscoding(false);
      }
    };

    recorder.start(100);
    await runSequence(true, exportConfig.scale);
    if (recorder.state !== 'inactive') recorder.stop();
  };

  const handleSnapshot = () => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `StudioFrame_${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setStatus('Frame exported as PNG');
  };

  const handleStop = () => {
    setIsRunning(false);
    stopDrawing();
    v1Ref.current?.pause();
    v2Ref.current?.pause();
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    disconnectAll();
    setStatus('Stopped');
    setProgress({ pct: 0, label: '' });
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 sm:px-6 py-4 border-b border-brand-border bg-brand-black/80 backdrop-blur-md sticky top-0 z-50">
        <Video className="w-5 h-5 text-brand-pink" />
        <div className="text-base font-bold tracking-[2px] text-white">
          VIDEO<span className="text-brand-pink/60 font-normal">MERGE</span>
        </div>
        <div className="hidden sm:block text-[10px] tracking-[1.5px] uppercase bg-brand-gray border border-brand-border rounded px-2 py-0.5 text-[#4a4a60]">
          Studio
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button 
            disabled={historyIndex <= 0} 
            onClick={undo}
            className="p-2 text-[#4a4a60] hover:text-brand-pink disabled:opacity-20 transition-colors"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button 
            disabled={historyIndex >= history.length - 1} 
            onClick={redo}
            className="p-2 text-[#4a4a60] hover:text-brand-pink disabled:opacity-20 transition-colors"
          >
            <Redo2 className="w-4 h-4" />
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto w-full p-6 space-y-8 flex-1">
        
        {/* Step 1: Sequential Timeline */}
        <section>
          <div className="text-[10px] tracking-[2.5px] uppercase text-[#4a4a60] mb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <span>01 — Playback Timeline</span>
            <div className="flex flex-wrap gap-2 w-full sm:w-auto">
               <button 
                onClick={() => setFormat('horizontal')}
                className={`flex-1 sm:flex-none flex flex-col items-center justify-center gap-1 px-4 py-2 rounded text-[10px] font-bold transition-all ${format === 'horizontal' ? 'bg-brand-pink text-white shadow-[0_0_15px_rgba(255,45,85,0.3)]' : 'text-[#4a4a60] bg-brand-gray border border-brand-border hover:text-[#8888a0]'}`}
               >
                 <MonitorPlay className="w-4 h-4" />
                 <span>YouTube</span>
               </button>
               <button 
                onClick={() => setFormat('vertical')}
                className={`flex-1 sm:flex-none flex flex-col items-center justify-center gap-1 px-4 py-2 rounded text-[10px] font-bold transition-all ${format === 'vertical' ? 'bg-brand-pink text-white shadow-[0_0_15px_rgba(255,45,85,0.3)]' : 'text-[#4a4a60] bg-brand-gray border border-brand-border hover:text-[#8888a0]'}`}
               >
                 <Smartphone className="w-4 h-4" />
                 <span>TikTok/Reels</span>
               </button>
               <button 
                onClick={() => setFormat('square')}
                className={`flex-1 sm:flex-none flex flex-col items-center justify-center gap-1 px-4 py-2 rounded text-[10px] font-bold transition-all ${format === 'square' ? 'bg-brand-pink text-white shadow-[0_0_15px_rgba(255,45,85,0.3)]' : 'text-[#4a4a60] bg-brand-gray border border-brand-border hover:text-[#8888a0]'}`}
               >
                 <Maximize className="w-4 h-4 rotate-45" />
                 <span>Instagram</span>
               </button>
            </div>
            
            <div className="flex gap-2 w-full sm:w-auto mt-2 sm:mt-0">
               <div className="text-[9px] uppercase tracking-tighter text-brand-pink/60 mr-2 self-center">Reframe:</div>
               <button 
                onClick={() => { setSizingMode('cover'); saveHistory({ sizingMode: 'cover' }); }}
                className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-[9px] font-bold transition-all ${sizingMode === 'cover' ? 'bg-brand-green text-black' : 'text-[#4a4a60] bg-brand-black border border-brand-border'}`}
               >
                 Fill Frame
               </button>
               <button 
                onClick={() => { setSizingMode('contain'); saveHistory({ sizingMode: 'contain' }); }}
                className={`flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-[9px] font-bold transition-all ${sizingMode === 'contain' ? 'bg-brand-green text-black' : 'text-[#4a4a60] bg-brand-black border border-brand-border'}`}
               >
                 Original Ratio
               </button>
            </div>
          </div>
          
          <div className="bg-brand-gray p-4 border border-brand-border rounded-lg">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 relative">
              {/* Timeline Connector - Transition Selector */}
              <div className="hidden sm:flex absolute inset-y-0 left-1/2 w-32 -ml-16 items-center justify-center z-20">
                <div className="flex flex-col gap-2 p-2 bg-brand-black border border-brand-border rounded-lg shadow-xl">
                  <div className="text-[8px] uppercase tracking-widest text-[#4a4a60] text-center font-bold">Transition</div>
                  <select 
                    value={transition.type} 
                    onChange={(e) => setTransition(prev => ({...prev, type: e.target.value as TransitionType}))}
                    className="bg-brand-gray text-[9px] text-brand-pink border border-brand-border rounded px-1 py-0.5 outline-none font-bold"
                  >
                    <option value="none">Cut</option>
                    <option value="fade">Crossfade</option>
                    <option value="slide-left">Slide L</option>
                    <option value="slide-right">Slide R</option>
                    <option value="wipe-left">Wipe L</option>
                    <option value="wipe-right">Wipe R</option>
                    <option value="dissolve">Dissolve</option>
                    <option value="zoom">Zoom</option>
                  </select>
                  <input 
                    type="range" min="0.5" max="3" step="0.1" 
                    value={transition.duration} 
                    onChange={(e) => setTransition(prev => ({...prev, duration: parseFloat(e.target.value)}))}
                    className="w-16 h-0.5 bg-brand-border rounded-lg appearance-none cursor-pointer accent-brand-pink mx-auto"
                  />
                </div>
              </div>

              {[1, 2].map((n) => {
                const active = n === 1 ? vid1 : vid2;
                const isPlaying = currentPlayIndex === n;
                return (
                  <div 
                    key={n}
                    onClick={() => document.getElementById(`f${n}`)?.click()}
                    className={`
                      relative flex flex-col justify-center items-center rounded-md border transition-all duration-300 cursor-pointer overflow-hidden min-h-[120px]
                      ${isPlaying ? 'border-brand-pink bg-brand-pink/5 shadow-[0_0_15px_rgba(255,45,85,0.1)]' : 'border-brand-border bg-brand-black hover:border-brand-pink/50'}
                    `}
                  >
                    <input type="file" id={`f${n}`} className="hidden" accept="video/*" onChange={(e) => e.target.files && handleLoadVideo(n as 1|2, e.target.files[0])} />
                    
                    {active ? (
                      <div className="w-full h-full flex flex-col">
                        <div className="flex-1 bg-black/40 relative overflow-hidden group min-h-[80px]">
                           <video src={active.url} className="w-full h-full object-cover opacity-60 group-hover:opacity-80 transition-opacity" />
                           <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/80 text-[10px] text-brand-pink font-mono">
                             {formatDuration(active.duration)}
                           </div>
                           {isPlaying && (
                             <div className="absolute inset-x-0 bottom-0 h-1 bg-brand-black">
                                <motion.div 
                                  className="h-full bg-brand-pink"
                                  initial={{ width: '0%' }}
                                  animate={{ width: '100%' }}
                                  transition={{ duration: (active.trim.end - active.trim.start) / (mix.speed / 100), ease: 'linear' }}
                                />
                             </div>
                           )}
                        </div>
                        
                        {/* Trim Controls */}
                        <div className="px-3 py-1 bg-black/60 border-t border-brand-border/30 flex flex-col gap-1">
                          <div className="flex justify-between items-center text-[8px] text-[#4a4a60]">
                             <span className="flex items-center gap-1"><Scissors className="w-2 h-2" /> Trim Start</span>
                             <span className="text-brand-pink">{formatDuration(active.trim.start)}</span>
                          </div>
                          <input 
                            type="range" step="0.1" min="0" max={active.duration} 
                            value={active.trim.start} 
                            onPointerUp={() => saveHistory({})}
                            onChange={(e) => {
                              const v = parseFloat(e.target.value);
                              const newTrim = { ...active.trim, start: Math.min(v, active.trim.end - 0.5) };
                              if (n === 1) setVid1({ ...active, trim: newTrim });
                              else setVid2({ ...active, trim: newTrim });
                            }}
                            className="w-full h-1 bg-brand-border rounded-lg appearance-none cursor-pointer accent-brand-pink opacity-50 hover:opacity-100" 
                          />
                          <div className="flex justify-between items-center text-[8px] text-[#4a4a60]">
                             <span>Trim End</span>
                             <span className="text-brand-pink font-bold">{formatDuration(active.trim.end)}</span>
                          </div>
                          <input 
                            type="range" step="0.1" min="0" max={active.duration} 
                            value={active.trim.end} 
                            onPointerUp={() => saveHistory({})}
                            onChange={(e) => {
                              const v = parseFloat(e.target.value);
                              const newTrim = { ...active.trim, end: Math.max(v, active.trim.start + 0.5) };
                              if (n === 1) setVid1({ ...active, trim: newTrim });
                              else setVid2({ ...active, trim: newTrim });
                            }}
                            className="w-full h-1 bg-brand-border rounded-lg appearance-none cursor-pointer accent-brand-pink opacity-50 hover:opacity-100" 
                          />
                        </div>

                        {/* Color Correction */}
                        <div className="px-3 py-2 bg-black/40 border-t border-brand-border/10 grid grid-cols-3 gap-2">
                          {['brightness', 'contrast', 'saturation'].map(f => (
                            <div key={f} className="flex flex-col gap-1">
                              <span className="text-[7px] uppercase text-[#4a4a60]">{f}</span>
                              <input 
                                type="range" min="0" max="200" value={active.filters[f as keyof typeof active.filters]}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  const newFilters = { ...active.filters, [f]: val };
                                  if (n === 1) setVid1({ ...active, filters: newFilters });
                                  else setVid2({ ...active, filters: newFilters });
                                }}
                                onPointerUp={() => saveHistory({})}
                                className="w-full h-0.5 accent-brand-green"
                              />
                            </div>
                          ))}
                        </div>

                        <div className="px-3 py-2 border-t border-brand-border flex items-center justify-between">
                           <span className="text-[10px] text-brand-pink font-bold uppercase tracking-tighter">Clip {n}</span>
                           <span className="text-[10px] text-[#4a4a60] truncate max-w-[120px]">{active.file.name}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2 opacity-40 p-4">
                        <Plus className="w-5 h-5 text-brand-pink" />
                        <span className="text-[10px] uppercase font-bold tracking-widest text-[#4a4a60]">Add Link {n}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* Step 2: Controls */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Audio Source */}
          <div className="p-5 bg-brand-gray border border-brand-border rounded-lg">
            <div className="text-[10px] tracking-wider uppercase text-[#4a4a60] font-bold mb-5 flex items-center gap-2">
              <Music className="w-3 h-3" /> Audio Routing
            </div>
            <div className="space-y-2">
              {[
                { id: 'v1', label: 'Stick to Clip 1 Audio' },
                { id: 'v2', label: 'Stick to Clip 2 Audio' },
                { id: 'both', label: 'Seamless Transition' },
                { id: 'custom', label: 'Voiceover / BGM Track' },
                { id: 'mute', label: 'Mute Project' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setAudioSource(opt.id as AudioSourceType)}
                  className={`
                    w-full flex items-center gap-3 px-3 py-3 rounded-md border text-xs transition-all duration-150
                    ${audioSource === opt.id 
                      ? 'border-brand-pink bg-brand-pink/10 text-brand-pink shadow-[0_0_10px_rgba(255,45,85,0.1)]' 
                      : 'border-brand-border text-[#8888a0] bg-brand-black/50 hover:bg-brand-gray hover:border-brand-pink/30'}
                  `}
                >
                  <div className={`w-2 h-2 rounded-full border-2 ${audioSource === opt.id ? 'bg-brand-pink border-brand-pink' : 'border-[#4a4a60]'}`} />
                  {opt.label}
                </button>
              ))}
            </div>

            <AnimatePresence>
              {audioSource === 'custom' && (
                <motion.div 
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="mt-4 overflow-hidden"
                >
                  <button 
                    onClick={() => document.getElementById('fa')?.click()}
                    className="w-full py-4 border border-dashed border-brand-border rounded-md text-[10px] text-[#4a4a60] hover:border-brand-pink transition-colors bg-brand-black"
                  >
                    <Plus className="w-4 h-4 mx-auto mb-1 opacity-50" />
                    {customAudio ? customAudio.name : 'Upload Voiceover / Music'}
                    <input 
                      type="file" 
                      id="fa" 
                      className="hidden" 
                      accept="audio/*,video/*" 
                      onChange={(e) => e.target.files && handleLoadAudio(e.target.files[0])} 
                    />
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Master Output Mixer */}
          <div className="p-5 bg-brand-gray border border-brand-border rounded-lg">
            <div className="text-[10px] tracking-wider uppercase text-[#4a4a60] font-bold mb-5 flex items-center gap-2">
              <Settings2 className="w-3 h-3" /> Master Output EQ & Visualizer
            </div>
            
            <div className="space-y-8">
              {/* Visualizer */}
              <div className="h-12 flex items-center gap-0.5 px-2 bg-brand-black/50 rounded-md overflow-hidden border border-brand-border/30">
                {Array.from(vizData).map((v, i) => (
                  <div 
                    key={i} 
                    className="flex-1 bg-brand-green/40 min-h-[1px]" 
                    style={{ height: `${((v as number) / 255) * 100}%` }} 
                  />
                ))}
              </div>

              {/* EQ Presets */}
              <div className="flex gap-2">
                {[
                  { label: 'Flat', bass:0, mid:0, treb:0 },
                  { label: 'Bass+', bass:8, mid:-2, treb:-2 },
                  { label: 'Vibe', bass:6, mid:0, treb:4 },
                  { label: 'Cloud', bass:-4, mid:2, treb:8 },
                ].map(p => (
                  <button
                    key={p.label}
                    onClick={() => {
                      setMix(prev => ({...prev, bass: p.bass, mid: p.mid, treble: p.treb}));
                      saveHistory({ mix: { ...mix, bass: p.bass, mid: p.mid, treble: p.treb } });
                    }}
                    className="flex-1 py-1 text-[8px] uppercase font-bold border border-brand-border rounded hover:border-brand-pink text-[#4a4a60] hover:text-brand-pink transition-all"
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Ducking Toggle */}
              <div className="flex items-center justify-between p-2 bg-brand-black/30 rounded border border-brand-border/20">
                <div className="flex flex-col">
                  <span className="text-[9px] font-bold text-white uppercase tracking-wider">Audio Ducking</span>
                  <span className="text-[7px] text-[#4a4a60]">Lowers music when clips speak</span>
                </div>
                <button 
                  onClick={() => {
                    const newDucking = !mix.ducking;
                    setMix(prev => ({ ...prev, ducking: newDucking }));
                    saveHistory({ mix: { ...mix, ducking: newDucking } });
                  }}
                  className={`w-10 h-5 rounded-full transition-all relative ${mix.ducking ? 'bg-brand-pink' : 'bg-[#4a4a60]'}`}
                >
                  <motion.div 
                    animate={{ x: mix.ducking ? 20 : 0 }}
                    className="absolute inset-y-1 left-1 w-3 bg-white rounded-full"
                  />
                </button>
              </div>

              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] text-white uppercase tracking-widest font-black">Master Volume</label>
                  <span className="text-[10px] text-brand-pink font-bold">{mix.volume}%</span>
                </div>
                <input type="range" value={mix.volume} onChange={(e) => {
                  const val = parseInt(e.target.value);
                  setMix(prev => ({...prev, volume: val}));
                }} onPointerUp={() => saveHistory({ mix })} className="w-full h-1.5 bg-brand-border rounded-lg appearance-none cursor-pointer accent-brand-pink" min="0" max="200" />
              </div>

              <div className="space-y-5 pt-4 border-t border-brand-border">
                {[
                  { id: 'bass', label: 'Bass' },
                  { id: 'mid', label: 'Mid' },
                  { id: 'treble', label: 'Treb' },
                ].map((band) => (
                  <div key={band.id} className="flex items-center gap-4">
                    <label className="text-[10px] text-[#8888a0] uppercase w-8">{band.label}</label>
                    <input type="range" min="-15" max="15" value={mix[band.id as keyof typeof mix]} onChange={(e) => setMix(prev => ({...prev, [band.id]: parseInt(e.target.value)}))} className="flex-1 h-0.5 bg-brand-border rounded-lg appearance-none cursor-pointer accent-brand-pink" />
                    <span className="text-[10px] text-brand-pink font-mono w-8 text-right">{mix[band.id as keyof typeof mix]}</span>
                  </div>
                ))}
              </div>

              <div className="space-y-3 pt-4 border-t border-brand-border">
                <div className="flex justify-between items-center">
                  <label className="text-[10px] text-[#8888a0] uppercase tracking-wider">Playback Tempo</label>
                  <span className="text-[10px] text-brand-pink font-bold">{(mix.speed/100).toFixed(2)}x</span>
                </div>
                <input type="range" value={mix.speed} min="50" max="200" step="5" onChange={(e) => setMix(prev => ({...prev, speed: parseInt(e.target.value)}))} className="w-full h-1 bg-brand-border rounded-lg appearance-none cursor-pointer accent-brand-pink" />
              </div>
            </div>
          </div>
        </section>

        {/* Step 3: Studio Monitor */}
        <section>
          <div className="text-[10px] tracking-[2.5px] uppercase text-[#4a4a60] mb-4">03 — Studio Monitor</div>
          <div className="bg-brand-gray border border-brand-border rounded-lg overflow-hidden shadow-[0_0_40px_rgba(0,0,0,0.5)]">
            {/* Monitor Canvas */}
            <div className={`
              bg-brand-black flex items-center justify-center relative group transition-all duration-500 overflow-hidden
              ${format === 'vertical' ? 'aspect-[9/16] w-full sm:w-[340px] mx-auto border-x border-brand-border shadow-2xl' : 'aspect-video'}
            `}>
              {!vid1 || !vid2 ? (
                <div className="text-center space-y-2 opacity-20">
                  <MonitorPlay className="w-10 h-10 mx-auto mb-2" />
                  <div className="text-xs">Timeline Empty</div>
                  <div className="text-[10px] uppercase">Load clips to activate monitor</div>
                </div>
              ) : (
                <canvas ref={canvasRef} className="max-w-full max-h-full" />
              )}

              {/* Status Overlay */}
              <AnimatePresence>
                {(isRunning || isTranscoding) && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                    className="absolute top-4 left-4 right-4 flex items-center justify-between pointer-events-none"
                  >
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-brand-black/80 backdrop-blur rounded-full border border-brand-pink/30 shadow-lg">
                      <div className={`w-2 h-2 rounded-full bg-brand-pink ${isRunning ? 'animate-pulse' : ''}`} />
                      <span className="text-[9px] uppercase font-bold tracking-tighter text-white">
                        {isTranscoding ? 'Processing MP4' : 'Rendering Timeline'}
                      </span>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Viewport Control */}
            <div className="p-3 bg-brand-black/20 flex items-center gap-4">
               <div className="flex flex-col gap-1 flex-1">
                 <div className="flex justify-between items-center text-[8px] text-[#4a4a60] uppercase">
                   <span>Monitor Zoom</span>
                   <span className="text-brand-pink">{viewport.zoom.toFixed(1)}x</span>
                 </div>
                 <input 
                  type="range" min="0.5" max="3" step="0.1" value={viewport.zoom}
                  onChange={(e) => {
                    const z = parseFloat(e.target.value);
                    setViewport(prev => ({ ...prev, zoom: z }));
                  }}
                  onPointerUp={() => saveHistory({ viewport: { ...viewport } })}
                  className="w-full h-1 accent-brand-pink"
                 />
               </div>
               <div className="flex flex-col gap-1 flex-1">
                 <div className="flex justify-between items-center text-[8px] text-[#4a4a60] uppercase">
                   <span>Monitor Pan X</span>
                   <span>{viewport.x}px</span>
                 </div>
                 <input 
                  type="range" min="-500" max="500" step="10" value={viewport.x}
                  onChange={(e) => {
                    const val = parseInt(e.target.value);
                    setViewport(prev => ({ ...prev, x: val }));
                  }}
                  onPointerUp={() => saveHistory({ viewport: { ...viewport } })}
                  className="w-full h-1 accent-brand-green"
                 />
               </div>
            </div>

            {/* Signal Path Console */}
            <div className="p-4 bg-brand-black border-t border-brand-border">
              <div className="flex items-center gap-3">
                <div className="w-1.5 h-1.5 rounded-full bg-brand-green shadow-[0_0_8px_rgba(57,255,20,0.5)] animate-pulse" />
                <div className="text-[11px] text-[#8888a0] font-mono flex-1">{status}</div>
                {isRunning && <div className="text-[11px] text-brand-pink font-mono">{progress.pct}%</div>}
              </div>
            </div>

            {/* Master Controls */}
            <div className="p-4 sm:p-6 flex flex-col sm:flex-row gap-4 items-center bg-brand-gray">
              <button 
                disabled={!vid1 || !vid2 || isRunning}
                onClick={handlePreview}
                className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-brand-black border border-brand-border hover:border-brand-pink/50 text-brand-pink disabled:opacity-30 rounded text-xs font-bold transition-all shadow-md group"
              >
                <Play className="w-4 h-4 fill-current group-hover:scale-110 transition-transform" /> Preview Timeline
              </button>

              <button 
                disabled={!vid1 && !vid2}
                onClick={handleSnapshot}
                className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-brand-gray border border-brand-border hover:border-brand-pink/50 text-[#8888a0] hover:text-brand-pink disabled:opacity-30 rounded text-xs font-bold transition-all shadow-md group"
              >
                <Camera className="w-4 h-4 group-hover:scale-110 transition-transform" /> Snapshot Frame
              </button>
              
              <button 
                disabled={!vid1 || !vid2 || isRunning || isTranscoding}
                onClick={() => setShowExportModal(true)}
                className={`
                  w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-3 rounded text-xs font-bold transition-all shadow-lg
                  ${isTranscoding ? 'bg-brand-gray text-brand-pink animate-pulse border border-brand-pink' : 'bg-brand-pink hover:bg-[#ff1b47] text-white'}
                  disabled:opacity-30
                `}
              >
                <Download className="w-4 h-4" /> {isTranscoding ? 'Converting...' : 'Export MP4'}
              </button>

              {isRunning && (
                <button onClick={handleStop} className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 border border-red-500/50 text-red-500 bg-red-500/5 hover:bg-red-500/10 rounded text-xs font-bold transition-all sm:ml-auto">
                  <Square className="w-4 h-4 fill-current" /> Stop
                </button>
              )}
            </div>
          </div>
          
          {/* Step 4: Overlays */}
          <div className="mt-8 pb-20">
            <div className="text-[10px] tracking-[2.5px] uppercase text-[#4a4a60] mb-4 flex items-center justify-between">
              <span>04 — Studio Overlays</span>
              <span className="text-brand-pink bg-brand-pink/10 px-2 py-0.5 rounded tracking-tighter">{textOverlays.length} Active Layers</span>
            </div>
            <div className="bg-brand-gray border border-brand-border rounded-lg p-4 space-y-4">
              <button 
                onClick={() => {
                  const newOverlay: TextOverlay = {
                    id: Math.random().toString(36).substr(2, 9),
                    text: 'NEW TEXT',
                    size: 80,
                    color: '#ffffff',
                    font: 'Inter',
                    x: 50,
                    y: 50
                  };
                  setTextOverlays(prev => [...prev, newOverlay]);
                  saveHistory({ textOverlays: [...textOverlays, newOverlay] });
                }}
                className="w-full py-3 bg-brand-black border border-brand-border border-dashed rounded flex items-center justify-center gap-2 text-white hover:text-brand-pink text-[10px] uppercase font-black transition-all bg-brand-black/50 hover:bg-brand-black"
              >
                <Plus className="w-3 h-3" /> Add Text Layer
              </button>

              <div className="space-y-3">
                {textOverlays.map(overlay => (
                  <div key={overlay.id} className="p-4 bg-brand-black/60 border border-brand-border/40 rounded-md flex flex-col gap-4 shadow-xl">
                    <div className="flex gap-2">
                       <input 
                        type="text" value={overlay.text} 
                        onChange={(e) => {
                          const next = textOverlays.map(o => o.id === overlay.id ? { ...o, text: e.target.value } : o);
                          setTextOverlays(next);
                        }}
                        onBlur={() => saveHistory({ textOverlays })}
                        className="flex-1 bg-brand-gray/50 border border-brand-border rounded px-3 py-1.5 text-[11px] text-white outline-none focus:border-brand-pink font-mono"
                       />
                       <button 
                        onClick={() => {
                          const next = textOverlays.filter(o => o.id !== overlay.id);
                          setTextOverlays(next);
                          saveHistory({ textOverlays: next });
                        }}
                        className="p-1 px-3 text-[10px] border border-brand-border rounded text-red-400 hover:bg-red-400/20 uppercase font-bold"
                       >
                         Delete
                       </button>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 px-1">
                       <div className="flex flex-col gap-2">
                          <span className="text-[8px] text-[#8888a0] uppercase tracking-widest">Font Size</span>
                          <input 
                            type="range" min="10" max="300" value={overlay.size} 
                            onChange={(e) => {
                              const next = textOverlays.map(o => o.id === overlay.id ? { ...o, size: parseInt(e.target.value) } : o);
                              setTextOverlays(next);
                            }}
                            onPointerUp={() => saveHistory({ textOverlays })}
                            className="h-1 accent-brand-pink"
                          />
                       </div>
                       <div className="flex flex-col gap-2">
                          <span className="text-[8px] text-[#8888a0] uppercase tracking-widest">X-Pos</span>
                          <input 
                            type="range" min="0" max="100" value={overlay.x} 
                            onChange={(e) => {
                              const next = textOverlays.map(o => o.id === overlay.id ? { ...o, x: parseInt(e.target.value) } : o);
                              setTextOverlays(next);
                            }}
                            onPointerUp={() => saveHistory({ textOverlays })}
                            className="h-1 accent-brand-green"
                          />
                       </div>
                       <div className="flex flex-col gap-2">
                          <span className="text-[8px] text-[#8888a0] uppercase tracking-widest">Y-Pos</span>
                          <input 
                            type="range" min="0" max="100" value={overlay.y} 
                            onChange={(e) => {
                              const next = textOverlays.map(o => o.id === overlay.id ? { ...o, y: parseInt(e.target.value) } : o);
                              setTextOverlays(next);
                            }}
                            onPointerUp={() => saveHistory({ textOverlays })}
                            className="h-1 accent-brand-green"
                          />
                       </div>
                       <div className="flex flex-col gap-2">
                          <span className="text-[8px] text-[#8888a0] uppercase tracking-widest">Font Style</span>
                          <select 
                            value={overlay.font} 
                            onChange={(e) => {
                              const next = textOverlays.map(o => o.id === overlay.id ? { ...o, font: e.target.value } : o);
                              setTextOverlays(next);
                            }}
                            onBlur={() => saveHistory({ textOverlays })}
                            className="bg-brand-gray border border-brand-border rounded px-2 py-1 text-[9px] text-white outline-none"
                          >
                            <option value="Inter">Inter (Sans)</option>
                            <option value="JetBrains Mono">JetBrains (Mono)</option>
                            <option value="Playfair Display">Playfair (Serif)</option>
                          </select>
                       </div>
                       <div className="flex flex-col gap-2">
                          <span className="text-[8px] text-[#8888a0] uppercase tracking-widest">Base Color</span>
                          <div className="flex items-center gap-2">
                            <input 
                              type="color" value={overlay.color} 
                              onChange={(e) => {
                                const next = textOverlays.map(o => o.id === overlay.id ? { ...o, color: e.target.value } : o);
                                setTextOverlays(next);
                              }}
                              onInput={() => saveHistory({ textOverlays })}
                              className="w-8 h-8 bg-transparent border-none p-0 cursor-pointer rounded overflow-hidden"
                            />
                            <span className="text-[9px] text-[#4a4a60] font-mono">{overlay.color}</span>
                          </div>
                       </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Footer info */}
        <footer className="pt-8 border-t border-[#35353f]/30 opacity-40">
           <div className="text-[10px] text-center uppercase tracking-widest leading-loose">
             High Fidelity Video Sequencing Unit // H.264 MP4 Transcoder Enabled // Vertical Format Support
           </div>
        </footer>
      </main>

      {/* Hidden processing nodes */}
      <div className="hidden">
        {/* Hidden internal elements */}
        {vid1 && <video ref={v1Ref} src={vid1.url} data-vid-id="v1" muted playsInline className="hidden" />}
        {vid2 && <video ref={v2Ref} src={vid2.url} data-vid-id="v2" muted playsInline className="hidden" />}
      </div>

      {/* Export Modal */}
      <AnimatePresence>
        {showExportModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              onClick={() => setShowExportModal(false)}
              className="absolute inset-0 bg-brand-black/90 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-brand-gray border border-brand-border rounded-xl p-6 shadow-2xl overflow-hidden"
            >
              <div className="flex items-center justify-between mb-6">
                 <div>
                   <h3 className="text-sm font-bold text-white uppercase tracking-widest">Advanced Export</h3>
                   <p className="text-[10px] text-[#4a4a60] uppercase mt-1">Configure final output quality</p>
                 </div>
                 <button onClick={() => setShowExportModal(false)} className="p-2 text-[#4a4a60] hover:text-white transition-colors">
                   <X className="w-5 h-5" />
                 </button>
              </div>

              <div className="space-y-6">
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-[10px] text-[#8888a0] uppercase tracking-wider">Video Bitrate</label>
                    <span className="text-brand-pink text-[10px] font-bold">{exportConfig.bitrate} kbps</span>
                  </div>
                  <input 
                    type="range" min="1000" max="15000" step="500" value={exportConfig.bitrate}
                    onChange={(e) => setExportConfig(prev => ({ ...prev, bitrate: parseInt(e.target.value) }))}
                    className="w-full h-1 bg-brand-black rounded appearance-none accent-brand-pink"
                  />
                  <div className="flex justify-between mt-1">
                    <span className="text-[8px] text-[#4a4a60]">Smaller File</span>
                    <span className="text-[8px] text-[#4a4a60]">Highest Quality</span>
                  </div>
                </div>

                <div>
                   <label className="text-[10px] text-[#8888a0] uppercase tracking-wider block mb-2">Frame Rate</label>
                   <div className="grid grid-cols-3 gap-2">
                     {[24, 30, 60].map(fps => (
                       <button 
                        key={fps} 
                        onClick={() => setExportConfig(prev => ({ ...prev, fps }))}
                        className={`py-2 rounded border text-[10px] font-bold transition-all ${exportConfig.fps === fps ? 'bg-brand-pink border-brand-pink text-white shadow-lg' : 'bg-brand-black border-brand-border text-[#4a4a60]'}`}
                       >
                         {fps} FPS
                       </button>
                     ))}
                   </div>
                </div>

                <div>
                   <label className="text-[10px] text-[#8888a0] uppercase tracking-wider block mb-2">Resolution Scale</label>
                   <div className="grid grid-cols-3 gap-2">
                     {[0.5, 0.75, 1.0].map(scale => (
                       <button 
                        key={scale} 
                        onClick={() => setExportConfig(prev => ({ ...prev, scale }))}
                        className={`py-2 rounded border text-[10px] font-bold transition-all ${exportConfig.scale === scale ? 'bg-brand-green border-brand-green text-black shadow-lg' : 'bg-brand-black border-brand-border text-[#4a4a60]'}`}
                       >
                         {scale === 0.5 ? '480p/540p' : scale === 0.75 ? '720p' : '1080p (Full)'}
                       </button>
                     ))}
                   </div>
                   <p className="text-[8px] text-[#4a4a60] mt-2 italic">* Scaling affects the resolution relative to your chosen aspect ratio.</p>
                </div>

                <button 
                  onClick={handleExport}
                  className="w-full py-4 bg-brand-pink text-white text-xs font-bold uppercase tracking-widest rounded-lg shadow-xl hover:bg-[#ff1b47] transition-all flex items-center justify-center gap-2"
                >
                  <Download className="w-4 h-4" /> Start Studio Export
                </button>
              </div>

              {/* Decorative background accent */}
              <div className="absolute top-0 right-0 w-32 h-32 bg-brand-pink/5 rounded-full -mr-16 -mt-16 blur-3xl pointer-events-none" />
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

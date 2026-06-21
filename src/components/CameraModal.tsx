import React, { useRef, useEffect, useState, useCallback } from 'react';
import { X, RefreshCw, AlertCircle, ChevronDown, Video, Zap } from 'lucide-react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

interface CameraModalProps {
    onCapture: (result: string) => void;
    onClose: () => void;
    type: 'product' | 'expiry';
}

interface CameraDevice {
    deviceId: string;
    label: string;
}

export const CameraModal: React.FC<CameraModalProps> = ({ onCapture, onClose, type }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const activeStreamRef = useRef<MediaStream | null>(null);
    const html5QrcodeRef = useRef<Html5Qrcode | null>(null);

    const [error, setError] = useState<string>('');
    const [isReady, setIsReady] = useState(false);
    const [cameras, setCameras] = useState<CameraDevice[]>([]);
    const [selectedCameraId, setSelectedCameraId] = useState<string>('');
    const [showCameraSelect, setShowCameraSelect] = useState(true);
    const [isLoading, setIsLoading] = useState(true);
    const [flashOn, setFlashOn] = useState(false);

    const killAllStreams = useCallback(async () => {
        setIsReady(false);
        
        // Stop html5-qrcode barcode scanner if active
        if (html5QrcodeRef.current) {
            if (html5QrcodeRef.current.isScanning) {
                try {
                    await html5QrcodeRef.current.stop();
                } catch (err) {
                    console.error('[Camera] Error stopping html5-qrcode scanner:', err);
                }
            }
            html5QrcodeRef.current = null;
        }

        // Stop standard media stream tracks
        if (activeStreamRef.current) {
            activeStreamRef.current.getTracks().forEach(track => track.stop());
            activeStreamRef.current = null;
        }

        // Reset video element
        if (videoRef.current) {
            videoRef.current.pause();
            const stream = videoRef.current.srcObject as MediaStream;
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
            }
            videoRef.current.srcObject = null;
            videoRef.current.load();
        }
    }, []);

    // Barcode scanner starter
    const startBarcodeScanner = useCallback(async (deviceId: string) => {
        try {
            // Ensure reader container exists in the DOM
            const readerElement = document.getElementById('reader');
            if (!readerElement) {
                console.error('[Barcode Scanner] Element #reader not found in DOM.');
                setError('Failed to find barcode reader element. Try switching cameras.');
                return;
            }

            const formats = [
                Html5QrcodeSupportedFormats.EAN_13,
                Html5QrcodeSupportedFormats.EAN_8,
                Html5QrcodeSupportedFormats.UPC_A,
                Html5QrcodeSupportedFormats.UPC_E,
                Html5QrcodeSupportedFormats.CODE_128,
                Html5QrcodeSupportedFormats.QR_CODE
            ];

            const html5Qrcode = new Html5Qrcode("reader", {
                verbose: false,
                formatsToSupport: formats,
                useBarCodeDetectorIfSupported: true
            });
            html5QrcodeRef.current = html5Qrcode;

            console.log('[Barcode Scanner] Starting reader with formats:', formats);
            await html5Qrcode.start(
                deviceId,
                {
                    fps: 10
                    // qrbox is omitted intentionally to allow decoding across the entire camera view frame
                },
                async (decodedText) => {
                    console.log('[Barcode Scanner] Barcode detected locally:', decodedText);
                    // Stop stream and return decoded text
                    try {
                        await html5Qrcode.stop();
                    } catch (e) {
                        console.error('[Barcode Scanner] Error stopping scanner:', e);
                    }
                    onCapture(decodedText);
                    onClose();
                },
                () => {
                    // Verbose scan failures occur per frame when no barcode is in view
                }
            );

            setIsReady(true);
            setError('');
        } catch (err: any) {
            console.error('[Barcode Scanner] Error starting html5-qrcode:', err);
            setError(`Failed to start barcode scanner: ${err.message || err}`);
        }
    }, [onCapture, onClose]);

    // Standard camera starter
    const startStandardCamera = useCallback(async (deviceId: string) => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }
            });
            activeStreamRef.current = stream;
            if (videoRef.current) {
                videoRef.current.srcObject = stream;
                videoRef.current.play().catch(() => { });
                setIsReady(true);
            }
            setError('');
        } catch (err) {
            console.error('[Camera] Error starting standard stream:', err);
            setError('Failed to start camera feed.');
        }
    }, []);

    // Enumerate cameras
    const getCameras = useCallback(async () => {
        setError('');
        setIsLoading(true);
        try {
            const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
            tempStream.getTracks().forEach(t => t.stop());

            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoDevices = devices
                .filter(d => d.kind === 'videoinput')
                .map(d => ({
                    deviceId: d.deviceId,
                    label: d.label || `Camera ${d.deviceId.slice(0, 8)}`
                }));

            setCameras(videoDevices);

            if (videoDevices.length > 0) {
                // Default to environment-facing camera if labeled
                const backCamera = videoDevices.find(c => 
                    c.label.toLowerCase().includes('back') || 
                    c.label.toLowerCase().includes('environment') || 
                    c.label.toLowerCase().includes('rear')
                );
                const selectedId = backCamera ? backCamera.deviceId : videoDevices[0].deviceId;
                setSelectedCameraId(selectedId);
                setShowCameraSelect(false);
            } else {
                setError('No camera input devices detected.');
            }
        } catch (err) {
            console.error('[Camera] Permission error:', err);
            setError('Camera access denied. Please allow camera permissions in browser, then click Retry.');
        } finally {
            setIsLoading(false);
        }
    }, []);

    // Main camera driver Effect - waits for showCameraSelect to resolve and DOM to mount
    useEffect(() => {
        if (!showCameraSelect && selectedCameraId) {
            let active = true;

            const initFeed = async () => {
                await killAllStreams();
                if (!active) return;

                if (type === 'product') {
                    await startBarcodeScanner(selectedCameraId);
                } else {
                    await startStandardCamera(selectedCameraId);
                }
            };

            initFeed();

            return () => {
                active = false;
            };
        }
    }, [showCameraSelect, selectedCameraId, type, killAllStreams, startBarcodeScanner, startStandardCamera]);

    // Permissions effect
    useEffect(() => {
        getCameras();
        return () => {
            killAllStreams();
        };
    }, [getCameras, killAllStreams]);

    // Apply flash/torch constraint dynamically
    useEffect(() => {
        if (type === 'product' && html5QrcodeRef.current && html5QrcodeRef.current.isScanning) {
            html5QrcodeRef.current.applyVideoConstraints({
                // @ts-ignore
                advanced: [{ torch: flashOn }]
            }).catch(() => {
                // Torch not supported
            });
        } else if (type === 'expiry' && activeStreamRef.current) {
            const track = activeStreamRef.current.getVideoTracks()[0];
            if (track) {
                track.applyConstraints({
                    // @ts-ignore
                    advanced: [{ torch: flashOn }]
                }).catch(() => {
                    // Torch not supported
                });
            }
        }
    }, [flashOn, type]);

    const handleSelectCamera = (deviceId: string) => {
        setSelectedCameraId(deviceId);
        setShowCameraSelect(false);
    };

    const handleClose = useCallback(async () => {
        await killAllStreams();
        onClose();
    }, [killAllStreams, onClose]);

    const handleCapture = useCallback(async () => {
        let videoEl = videoRef.current;
        
        // If in product mode, capture snapshot from html5-qrcode video track
        if (type === 'product') {
            videoEl = document.querySelector('#reader video') as HTMLVideoElement;
        }

        if (!videoEl || !canvasRef.current) return;
        const context = canvasRef.current.getContext('2d');
        if (!context) return;

        canvasRef.current.width = videoEl.videoWidth || videoEl.clientWidth || 640;
        canvasRef.current.height = videoEl.videoHeight || videoEl.clientHeight || 480;
        context.drawImage(videoEl, 0, 0);
        const imageSrc = canvasRef.current.toDataURL('image/jpeg');

        await killAllStreams();
        onCapture(imageSrc);
        onClose();
    }, [killAllStreams, onCapture, onClose, type]);

    const handleSwitchCamera = () => {
        killAllStreams();
        setShowCameraSelect(true);
        setIsReady(false);
    };

    const statusText = type === 'product' ? 'Scanning Barcode...' : 'Detecting Expiry Date...';

    return (
        <div className="fixed inset-0 z-[60] bg-black flex flex-col items-center justify-center overflow-hidden">
            {/* Header */}
            <header className="absolute top-0 left-0 right-0 z-50 p-4 flex justify-between items-center pointer-events-none">
                <div className="pointer-events-auto flex items-center gap-3 bg-white/10 dark:bg-gray-800/60 backdrop-blur-xl rounded-2xl px-4 py-2 shadow-lg border border-white/10">
                    <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center text-white shadow-lg shadow-emerald-500/30">
                        <Zap size={16} />
                    </div>
                    <div>
                        <h1 className="font-bold text-sm text-white leading-tight">Smart Bite</h1>
                        <p className="text-[10px] text-gray-300">Scanner Mode</p>
                    </div>
                </div>
                <button
                    onClick={handleClose}
                    className="pointer-events-auto w-10 h-10 rounded-full bg-white/10 backdrop-blur-xl flex items-center justify-center text-white hover:bg-white/20 transition-colors border border-white/10"
                >
                    <X size={20} />
                </button>
            </header>

            {/* Camera Selector View */}
            {showCameraSelect ? (
                <div className="w-full max-w-md p-6">
                    <div className="bg-gray-900/90 backdrop-blur-xl rounded-3xl p-6 border border-gray-700/50 shadow-2xl">
                        <div className="flex items-center gap-3 mb-6">
                            <div className="p-3 bg-emerald-500/20 rounded-xl">
                                <Video size={24} className="text-emerald-400" />
                            </div>
                            <div>
                                <h2 className="text-white font-bold text-lg">Select Camera</h2>
                                <p className="text-gray-400 text-sm">Choose which camera to use</p>
                            </div>
                        </div>

                        {error ? (
                            <div className="text-center py-4">
                                <AlertCircle className="mx-auto text-rose-500 mb-3" size={32} />
                                <p className="text-white text-sm mb-4">{error}</p>
                                <button
                                    onClick={getCameras}
                                    className="px-6 py-2.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-xl font-semibold transition-colors shadow-lg shadow-emerald-500/30"
                                >
                                    Retry
                                </button>
                            </div>
                        ) : isLoading ? (
                            <div className="text-center py-6">
                                <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin mx-auto mb-3"></div>
                                <p className="text-gray-400 text-sm">Detecting cameras...</p>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {cameras.map((camera, idx) => (
                                    <button
                                        key={camera.deviceId}
                                        onClick={() => handleSelectCamera(camera.deviceId)}
                                        className="w-full flex items-center gap-3 p-4 bg-gray-800/80 hover:bg-gray-700 rounded-xl transition-all text-left group hover:translate-x-1"
                                    >
                                        <div className="w-10 h-10 bg-gray-700 group-hover:bg-emerald-500/20 rounded-lg flex items-center justify-center transition-colors">
                                            <Video size={18} className="text-gray-400 group-hover:text-emerald-400" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p className="text-white font-medium truncate">{camera.label}</p>
                                            <p className="text-gray-500 text-xs">Camera {idx + 1}</p>
                                        </div>
                                        <ChevronDown size={18} className="text-gray-500 -rotate-90" />
                                    </button>
                                ))}
                            </div>
                        )}

                        <button onClick={handleClose} className="w-full mt-6 py-3 text-gray-500 hover:text-gray-400 font-medium text-sm transition-colors">
                            Cancel
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    {/* Camera Viewport */}
                    <div className="relative w-full h-full flex items-center justify-center bg-black">
                        {error ? (
                            <div className="text-center p-6 bg-gray-900/90 backdrop-blur-xl rounded-2xl border border-gray-700/50 shadow-2xl">
                                <AlertCircle className="mx-auto text-rose-500 mb-2" size={32} />
                                <p className="text-white">{error}</p>
                                <button onClick={handleSwitchCamera} className="mt-4 px-4 py-2 bg-emerald-500 text-white rounded-lg text-sm shadow-lg shadow-emerald-500/30">
                                    Try Another Camera
                                </button>
                            </div>
                        ) : type === 'product' ? (
                            <div id="reader" className="w-full h-full bg-black" />
                        ) : (
                            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                        )}

                        {/* Scanner Viewfinder Overlays */}
                        {!error && (
                            <div className="absolute inset-0 pointer-events-none flex flex-col items-center justify-center p-6">
                                <div className={`relative w-full max-w-md border-2 border-white/20 rounded-[2rem] overflow-hidden shadow-2xl ${type === 'product' ? 'aspect-[2.2/1] border-emerald-500/30' : 'aspect-[3/4] md:aspect-square'}`}>
                                    {/* Corner Brackets */}
                                    <div className="absolute top-0 left-0 w-12 h-12 border-t-4 border-l-4 border-emerald-500 rounded-tl-[1.8rem] shadow-[0_0_15px_rgba(16,185,129,0.5)]"></div>
                                    <div className="absolute top-0 right-0 w-12 h-12 border-t-4 border-r-4 border-emerald-500 rounded-tr-[1.8rem] shadow-[0_0_15px_rgba(16,185,129,0.5)]"></div>
                                    <div className="absolute bottom-0 left-0 w-12 h-12 border-b-4 border-l-4 border-emerald-500 rounded-bl-[1.8rem] shadow-[0_0_15px_rgba(16,185,129,0.5)]"></div>
                                    <div className="absolute bottom-0 right-0 w-12 h-12 border-b-4 border-r-4 border-emerald-500 rounded-br-[1.8rem] shadow-[0_0_15px_rgba(16,185,129,0.5)]"></div>

                                    {/* Animated Scan Line */}
                                    <div className="absolute top-0 left-0 w-full h-full overflow-hidden">
                                        <div className="scan-line animate-scan"></div>
                                    </div>

                                    {/* Center Target Text */}
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <div className="px-4 py-2 border border-dashed border-white/20 rounded-lg bg-black/30 backdrop-blur-sm">
                                            <span className="text-white/60 text-[10px] font-semibold uppercase tracking-wider">
                                                {type === 'product' ? 'Align Barcode Inside Box' : 'Align Expiry Date'}
                                            </span>
                                        </div>
                                    </div>
                                </div>

                                {isReady && (
                                    <div className="mt-6 transform transition-all">
                                        <div className="bg-white/10 dark:bg-gray-800/90 backdrop-blur-xl px-5 py-2.5 rounded-full shadow-lg border border-white/10 flex items-center gap-3">
                                            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                                            <span className="text-xs font-semibold text-white">{statusText}</span>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    {/* Camera Control Footer */}
                    {!error && (
                        <div className="absolute bottom-0 left-0 right-0 p-6 pb-10 flex justify-between items-center z-20 pointer-events-none">
                            {/* Flash Toggle */}
                            <button
                                onClick={() => setFlashOn(!flashOn)}
                                className={`pointer-events-auto w-12 h-12 rounded-full backdrop-blur-md border flex items-center justify-center transition-colors
                                    ${flashOn ? 'bg-white text-gray-900 border-white' : 'bg-black/40 border-white/10 text-white hover:bg-white/10'}`}
                            >
                                <Zap size={20} className={flashOn ? 'fill-current' : ''} />
                            </button>

                            {/* Capture Button */}
                            <button
                                onClick={handleCapture}
                                disabled={!isReady}
                                className="pointer-events-auto relative w-20 h-20 rounded-full border-4 border-white/30 flex items-center justify-center group hover:scale-105 transition-transform"
                            >
                                <div className={`w-15 h-15 bg-white rounded-full group-hover:bg-emerald-500 transition-colors duration-200 ${!isReady ? 'opacity-50' : ''}`}></div>
                            </button>

                            {/* Camera Switch button */}
                            <button
                                onClick={handleSwitchCamera}
                                className="pointer-events-auto w-12 h-12 rounded-full bg-black/40 backdrop-blur-md border border-white/10 flex items-center justify-center text-white hover:bg-white/10 transition-colors"
                            >
                                <RefreshCw size={20} />
                            </button>
                        </div>
                    )}
                </>
            )}

            <canvas ref={canvasRef} className="hidden" />

            {/* Scan animation styling */}
            <style>{`
                .scan-line {
                    background: linear-gradient(to bottom, rgba(16, 185, 129, 0), rgba(16, 185, 129, 0.8), rgba(16, 185, 129, 0));
                    height: 4px;
                    width: 100%;
                    position: absolute;
                    top: 0;
                    left: 0;
                    box-shadow: 0 0 15px rgba(16, 185, 129, 0.6);
                }
                @keyframes scan {
                    0%, 100% { 
                        transform: translateY(0); 
                        opacity: 0.4; 
                    }
                    50% { 
                        transform: translateY(calc(100% - 4px)); 
                        opacity: 1; 
                    }
                }
                .animate-scan {
                    animation: scan 2.5s ease-in-out infinite;
                }
                #reader {
                    width: 100% !important;
                    height: 100% !important;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                #reader video {
                    width: 100% !important;
                    height: 100% !important;
                    object-fit: cover !important;
                }
                #reader__qr_coords_container {
                    display: none !important;
                }
            `}</style>
        </div>
    );
};

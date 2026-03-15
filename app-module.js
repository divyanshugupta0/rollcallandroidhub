// Import Firebase modules
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged, updateProfile, setPersistence, indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js";
import { getDatabase, ref, set, get, child, remove, update, onValue, push, query, orderByKey, startAt, limitToFirst } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-database.js";
import { getStorage, ref as storageRef, uploadString, getDownloadURL } from "https://www.gstatic.com/firebasejs/11.6.0/firebase-storage.js";

// Firebase Configuration
const firebaseConfig = {
    apiKey: "AIzaSyD_An-qb0XTLpaLdrOftAEOqsshGpPbv1w",
    authDomain: "firefly-64eef.firebaseapp.com",
    databaseURL: "https://firefly-64eef-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "firefly-64eef",
    storageBucket: "firefly-64eef.firebasestorage.app",
    messagingSenderId: "563239732954",
    appId: "1:563239732954:web:1774bfd1f7aceedeb707e3"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const database = getDatabase(app);
const storage = getStorage(app);

// Cloudflare R2 profile photo settings
const R2_PROFILE_PHOTO_CONFIG = {
    maxBytes: 2 * 1024 * 1024,
    maxDimension: 640,
    outputType: 'image/webp',
    quality: 0.8
};

const R2_CONFIG_PATH = 'cloudflare_r2'; // Firebase path storing Cloudflare R2 config
const R2_ENDPOINT_PATH = 'cloudflare_endpoint';
let r2RuntimeConfig = null;
let r2ConfigPromise = null;
let r2ListenerAttached = false;
let r2RuntimeHash = null;

function normalizeR2Config(data) {
    if (!data || typeof data !== 'object') return null;
    const uploadEndpoint = data.cloudflare_endpoint || data.cloudflareEndpoint || data.uploadEndpoint || data.upload_endpoint || data.r2_upload_endpoint || '';
    const publicBaseUrl = data.cloudflare_public_base_url || data.cloudflarePublicBaseUrl || data.publicBaseUrl || data.public_base_url || data.r2_public_base_url || data.cdnBaseUrl || '';
    const tokenValue = data.cloudflare_token_value || data.cloudflare_token || data.cloudflare_api_token || data.token || data.r2_token || '';
    const authToken = data.authToken || data.authorization || '';
    const accessKeyId = data.cloudflare_access_key_id || data.accessKeyId || '';
    const secretAccessKey = data.cloudflare_secret_access_key || data.secretAccessKey || '';

    let resolvedUploadEndpoint = uploadEndpoint;
    let resolvedAuthToken = authToken || tokenValue;
    if (!resolvedUploadEndpoint && tokenValue && /^https?:\/\//i.test(tokenValue)) {
        resolvedUploadEndpoint = tokenValue;
        resolvedAuthToken = authToken;
    }

    return {
        uploadEndpoint: resolvedUploadEndpoint,
        publicBaseUrl: publicBaseUrl,
        authToken: resolvedAuthToken,
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey,
        updatedAt: data.updatedAt || data.updated_at || data.lastUpdated || null
    };
}

function cacheR2Config(config) {
    if (!config) return;
    r2RuntimeConfig = config;
    try {
        r2RuntimeHash = JSON.stringify(config);
    } catch (e) {
        r2RuntimeHash = null;
    }
}

function mergeR2Endpoint(endpointValue) {
    if (!endpointValue) return;
    const cached = r2RuntimeConfig || {};
    if (cached.uploadEndpoint === endpointValue) return;
    cacheR2Config({
        ...cached,
        uploadEndpoint: endpointValue
    });
}

function attachR2ConfigListener() {
    if (r2ListenerAttached) return;
    r2ListenerAttached = true;
    onValue(ref(database, R2_CONFIG_PATH), (snapshot) => {
        if (!snapshot.exists()) return;
        const normalized = normalizeR2Config(snapshot.val());
        if (!normalized) return;
        const nextHash = JSON.stringify(normalized);
        if (r2RuntimeHash === nextHash) {
            return;
        }
        cacheR2Config({
            ...(r2RuntimeConfig || {}),
            ...normalized
        });
    });
    onValue(ref(database, R2_ENDPOINT_PATH), (snapshot) => {
        if (!snapshot.exists()) return;
        const endpointValue = snapshot.val();
        mergeR2Endpoint(endpointValue);
    });
}

async function ensureR2RuntimeConfig() {
    if (r2RuntimeConfig) return r2RuntimeConfig;
    if (r2ConfigPromise) {
        return r2ConfigPromise;
    }
    r2ConfigPromise = Promise.all([
        get(ref(database, R2_CONFIG_PATH)).catch(() => null),
        get(ref(database, R2_ENDPOINT_PATH)).catch(() => null)
    ])
        .then(([configSnapshot, endpointSnapshot]) => {
            let normalized = {};
            if (configSnapshot && configSnapshot.exists()) {
                const next = normalizeR2Config(configSnapshot.val());
                if (next) {
                    normalized = next;
                }
            }
            if (endpointSnapshot && endpointSnapshot.exists()) {
                normalized.uploadEndpoint = endpointSnapshot.val();
            }
            if (!normalized.uploadEndpoint) {
                throw new Error('R2 upload endpoint is not configured.');
            }
            cacheR2Config(normalized);
            attachR2ConfigListener();
            return normalized;
        })
        .finally(() => {
            r2ConfigPromise = null;
        });
    return r2ConfigPromise;
}

function getImageDimensions(width, height, maxDimension) {
    if (!width || !height) return { width, height };
    if (width <= maxDimension && height <= maxDimension) {
        return { width, height };
    }
    const ratio = Math.min(maxDimension / width, maxDimension / height);
    return {
        width: Math.round(width * ratio),
        height: Math.round(height * ratio)
    };
}

async function loadImageSource(file) {
    if (window.createImageBitmap) {
        try {
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (e) {
            // Ignore and fallback
        }
        try {
            return await createImageBitmap(file);
        } catch (e) {
            // Ignore and fallback
        }
    }
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);
        img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(img);
        };
        img.onerror = (err) => {
            URL.revokeObjectURL(objectUrl);
            reject(err);
        };
        img.src = objectUrl;
    });
}

async function compressImageFile(file) {
    const image = await loadImageSource(file);
    const { width, height } = getImageDimensions(image.width, image.height, R2_PROFILE_PHOTO_CONFIG.maxDimension);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.drawImage(image, 0, 0, width, height);

    const blob = await new Promise((resolve) => {
        canvas.toBlob(resolve, R2_PROFILE_PHOTO_CONFIG.outputType, R2_PROFILE_PHOTO_CONFIG.quality);
    });

    if (blob) {
        return blob;
    }

    const fallbackBlob = await new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', R2_PROFILE_PHOTO_CONFIG.quality);
    });

    return fallbackBlob || file;
}

async function requestR2Upload({ userId, contentType, contentLength, fileName }) {
    const r2Config = await ensureR2RuntimeConfig();
    if (!r2Config || !r2Config.uploadEndpoint) {
        throw new Error('R2 upload endpoint is not configured.');
    }
    const headers = { 'Content-Type': 'application/json' };
    if (r2Config.authToken) {
        headers.Authorization = /^Bearer\s+/i.test(r2Config.authToken) || /^Token\s+/i.test(r2Config.authToken)
            ? r2Config.authToken
            : `Bearer ${r2Config.authToken}`;
    }
    const response = await fetch(r2Config.uploadEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            userId,
            contentType,
            contentLength,
            fileName
        })
    });
    if (!response.ok) {
        throw new Error('Failed to get R2 upload URL.');
    }
    return response.json();
}

function resolvePublicProfileUrl(uploadInfo, r2Config) {
    if (uploadInfo && uploadInfo.publicUrl) {
        return uploadInfo.publicUrl;
    }
    const publicBaseUrl = r2Config && r2Config.publicBaseUrl ? r2Config.publicBaseUrl : '';
    if (uploadInfo && uploadInfo.key && publicBaseUrl) {
        return `${publicBaseUrl.replace(/\/$/, '')}/${uploadInfo.key}`;
    }
    return null;
}

async function uploadProfilePhoto(file, userId) {
    if (!file) {
        throw new Error('No file selected for upload.');
    }
    if (file.size > R2_PROFILE_PHOTO_CONFIG.maxBytes) {
        throw new Error('Image size must be less than 2MB.');
    }

    const r2Config = await ensureR2RuntimeConfig();
    const compressedBlob = await compressImageFile(file);
    const contentType = compressedBlob.type || 'image/jpeg';
    const extension = contentType === 'image/webp' ? 'webp' : 'jpg';
    const fileName = `${userId || 'user'}-${Date.now()}.${extension}`;

    const uploadInfo = await requestR2Upload({
        userId,
        contentType,
        contentLength: compressedBlob.size,
        fileName
    });

    if (!uploadInfo || !uploadInfo.uploadUrl) {
        throw new Error('Upload URL missing from R2 response.');
    }

    const uploadResponse = await fetch(uploadInfo.uploadUrl, {
        method: 'PUT',
        headers: {
            'Content-Type': contentType
        },
        body: compressedBlob
    });

    if (!uploadResponse.ok) {
        throw new Error('R2 upload failed.');
    }

    const publicUrl = resolvePublicProfileUrl(uploadInfo, r2Config);
    if (!publicUrl) {
        throw new Error('Public profile photo URL could not be resolved.');
    }

    return {
        publicUrl,
        key: uploadInfo.key || null
    };
}

// Expose Firebase functions globally for dynamic scripts
window.database = database;
window.auth = auth;
window.ref = ref;
window.get = get;
window.set = set;
window.update = update;
window.onValue = onValue;
window.calculateDistance = calculateDistance;

// Expose global variables
window.currentUser = null;
window.currentPosition = null;
window.attendedClasses = new Set();
let registrationLiveStatus = null;
let desktopAttendanceBlocked = true;
let isRegistering = false;

function lockRegisterButton(message) {
    const registerBtn = document.getElementById('register-btn');
    if (!registerBtn) return;
    if (!registerBtn.dataset.defaultHtml) {
        registerBtn.dataset.defaultHtml = registerBtn.innerHTML;
    }
    registerBtn.disabled = true;
    registerBtn.innerHTML = message || '<i class="fas fa-lock"></i> Registrations Closed';
}

function unlockRegisterButton() {
    const registerBtn = document.getElementById('register-btn');
    if (!registerBtn) return;
    const defaultHtml = registerBtn.dataset.defaultHtml || registerBtn.innerHTML;
    registerBtn.disabled = false;
    registerBtn.innerHTML = defaultHtml;
}

function updateRegistrationUI(isLive) {
    registrationLiveStatus = isLive === true;
    const registerLink = document.getElementById('register-link');
    if (registerLink) {
        registerLink.style.display = registrationLiveStatus ? 'block' : 'none';
    }
    if (registrationLiveStatus) {
        unlockRegisterButton();
    } else {
        lockRegisterButton('<i class="fas fa-lock"></i> Registrations Closed');
    }
}

function applyAccessibilitySettings(settings) {
    const registrationLive = settings && settings.registrationLive !== undefined
        ? settings.registrationLive === true
        : true;
    desktopAttendanceBlocked = settings && settings.desktopAttendanceBlocked !== undefined
        ? settings.desktopAttendanceBlocked !== false
        : true;
    updateRegistrationUI(registrationLive);
}

// Check accessibility settings on page load
function checkAccessibilitySettings() {
    get(ref(database, 'accessibility_settings'))
        .then((snapshot) => {
            const settings = snapshot.exists() ? snapshot.val() : null;
            applyAccessibilitySettings(settings);
        })
        .catch((error) => {
            console.error('Error checking accessibility settings:', error);
            applyAccessibilitySettings(null);
        });
}

// Call on page load
document.addEventListener('DOMContentLoaded', () => {
    lockRegisterButton('<i class="fas fa-spinner fa-spin"></i> Checking availability...');
    checkAccessibilitySettings();
});

// Auth State Observer for Missing Photo Check
onAuthStateChanged(auth, (user) => {
    if (user && isRegistering) {
        return;
    }
    if (user) {
        // User is signed in
        console.log("Auth check: User is signed in", user.uid);

        // Cache-first user data load
        const cachedUser = getCachedUserData(user.uid);
        if (cachedUser) {
            window.currentUser = { ...user, ...cachedUser };
            if (cachedUser.profilePhoto && document.getElementById('user-profile-img')) {
                applyEncryptedPhotoToImg(
                    document.getElementById('user-profile-img'),
                    cachedUser.profilePhoto,
                    cachedUser.profilePhotoKey || cachedUser.profilePhoto
                );
            }
        }

        // Fetch user data to check for profile photo
        get(ref(database, `users/${user.uid}`)).then((snapshot) => {
            if (snapshot.exists()) {
                const userData = snapshot.val();
                cacheUserData(user.uid, userData);
                // Update global currentUser with DB data
                window.currentUser = { ...user, ...userData };

                // If user is blocked, do not show profile-required modal
                if (userData.blocked === true) {
                    const modal = document.getElementById('missing-photo-modal');
                    if (modal) modal.classList.remove('visible');
                    showBlockedUserPopup();
                    signOut(auth);
                    return;
                }
                enforceIosLocalLockOnReload(user)
                    .then((blocked) => {
                        if (blocked) return;
                        // Check if profile photo exists
                        if (!userData.profilePhoto) {
                            console.warn("User missing profile photo. Showing mandatory update modal.");
                            setTimeout(() => {
                                const modal = document.getElementById('missing-photo-modal');
                                if (modal) modal.classList.add('visible');
                            }, 1000); // Small delay to ensure UI is ready
                        } else {
                            // Ensure modal is closed if they have a photo
                            const modal = document.getElementById('missing-photo-modal');
                            if (modal) modal.classList.remove('visible');

                            // Also update the profile image on the main UI if available
                            if (document.getElementById('user-profile-img')) {
                                applyEncryptedPhotoToImg(
                                    document.getElementById('user-profile-img'),
                                    userData.profilePhoto,
                                    userData.profilePhotoKey || userData.profilePhoto
                                );
                            }
                        }
                    })
                    .catch((error) => {
                        console.error('Error enforcing iOS lock on reload:', error);
                    });
            }
        }).catch((error) => {
            console.error("Error checking user profile:", error);
        });
    }
});

// Toggle password visibility function
function togglePasswordVisibility() {
    const passwordInput = document.getElementById('password');
    const toggleIcon = document.getElementById('password-toggle-icon');
    const toggleBtn = document.getElementById('toggle-password');
    if (!passwordInput || !toggleIcon) return;

    const isMasked = passwordInput.type === 'password';
    passwordInput.type = isMasked ? 'text' : 'password';
    toggleIcon.classList.toggle('fa-eye', !isMasked);
    toggleIcon.classList.toggle('fa-eye-slash', isMasked);
    if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', String(isMasked));
        toggleBtn.setAttribute('aria-label', isMasked ? 'Hide password' : 'Show password');
    }
}

const togglePasswordBtn = document.getElementById('toggle-password');
if (togglePasswordBtn) {
    togglePasswordBtn.addEventListener('click', togglePasswordVisibility);
}

// Profile image upload handler
let profileImageFile = null;

function handleProfileImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
        alert('Please select a valid image file');
        return;
    }

    // Validate file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
        alert('Image size must be less than 2MB');
        return;
    }

    profileImageFile = file;

    const reader = new FileReader();
    reader.onload = function (e) {
        const base64String = e.target.result;

        // Update preview image
        const previewImg = document.getElementById('profile-preview');
        previewImg.src = base64String;

        // Update UI to show image is uploaded
        const previewWrapper = document.getElementById('photo-preview-wrapper');
        previewWrapper.classList.add('has-image');

        // Update hint text
        const hint = document.querySelector('.photo-hint');
        hint.innerHTML = '<i class="fas fa-check-circle"></i> Photo uploaded successfully';
        hint.classList.add('uploaded');
    };

    reader.onerror = function () {
        alert('Error reading file. Please try again.');
    };

    reader.readAsDataURL(file);
}

// Make it globally accessible
window.handleProfileImageUpload = handleProfileImageUpload;

// --- Missing Photo Modal Logic ---
let missingPhotoFile = null;

function handleMissingPhotoUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        alert('Please select a valid image file');
        return;
    }

    if (file.size > 2 * 1024 * 1024) {
        alert('Image size must be less than 2MB');
        return;
    }

    missingPhotoFile = file;

    const reader = new FileReader();
    reader.onload = function (e) {
        const base64String = e.target.result;

        // Update UI
        document.getElementById('missing-photo-preview').src = base64String;
        document.getElementById('missing-photo-preview-wrapper').classList.add('has-image');

        const hint = document.getElementById('missing-photo-hint');
        hint.innerHTML = '<i class="fas fa-check-circle"></i> Ready to save';
        hint.classList.add('uploaded');

        // Enable save button
        const saveBtn = document.getElementById('save-missing-photo-btn');
        saveBtn.disabled = false;
        saveBtn.onclick = saveMissingPhoto;
    };
    reader.readAsDataURL(file);
}

async function saveMissingPhoto() {
    if (!currentUser || !missingPhotoFile) return;

    const saveBtn = document.getElementById('save-missing-photo-btn');
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
    saveBtn.disabled = true;

    try {
        const uploadResult = await uploadProfilePhoto(missingPhotoFile, currentUser.uid);
        const profilePhotoUrl = uploadResult.publicUrl;

        await update(ref(database, `users/${currentUser.uid}`), {
            profilePhoto: profilePhotoUrl,
            profilePhotoKey: uploadResult.key || null,
            profilePhotoUpdatedAt: Date.now()
        });

        document.getElementById('missing-photo-modal').classList.remove('visible');

        if (document.getElementById('user-profile-img')) {
            applyEncryptedPhotoToImg(
                document.getElementById('user-profile-img'),
                profilePhotoUrl,
                uploadResult.key || profilePhotoUrl
            );
        }

        currentUser.profilePhoto = profilePhotoUrl;
        currentUser.profilePhotoKey = uploadResult.key || null;
        window.currentUser = currentUser;
        cacheUserData(currentUser.uid, {
            ...(getCachedUserData(currentUser.uid) || {}),
            profilePhoto: profilePhotoUrl,
            profilePhotoKey: uploadResult.key || null
        });
        missingPhotoFile = null;
    } catch (error) {
        console.error("Error saving photo:", error);
        alert("Failed to save photo. Please try again.");
    } finally {
        saveBtn.innerHTML = '<i class="fas fa-save"></i> Save & Continue';
        saveBtn.disabled = false;
    }
}

window.handleMissingPhotoUpload = handleMissingPhotoUpload;
// ---------------------------------

// Storage helper (localStorage -> sessionStorage -> in-memory)
const safeStorage = (() => {
    try {
        const testKey = '__rollcall_storage_test__';
        localStorage.setItem(testKey, '1');
        localStorage.removeItem(testKey);
        return {
            type: 'local',
            getItem: (key) => localStorage.getItem(key),
            setItem: (key, value) => localStorage.setItem(key, String(value)),
            removeItem: (key) => localStorage.removeItem(key)
        };
    } catch (e) {
        // Ignore and try session storage
    }
    try {
        const testKey = '__rollcall_storage_test__';
        sessionStorage.setItem(testKey, '1');
        sessionStorage.removeItem(testKey);
        return {
            type: 'session',
            getItem: (key) => sessionStorage.getItem(key),
            setItem: (key, value) => sessionStorage.setItem(key, String(value)),
            removeItem: (key) => sessionStorage.removeItem(key)
        };
    } catch (e) {
        // Ignore and fallback to memory storage
    }
    const memoryStore = {};
    return {
        type: 'memory',
        getItem: (key) => Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null,
        setItem: (key, value) => { memoryStore[key] = String(value); },
        removeItem: (key) => { delete memoryStore[key]; }
    };
})();

window.safeStorage = safeStorage;

// Encrypted photo cache (IndexedDB + AES-GCM)
const PHOTO_CACHE_DB = 'rollcall_photo_cache_v1';
const PHOTO_CACHE_STORE = 'photos';
const PHOTO_CACHE_KEY_STORAGE = 'rollcall_photo_cache_key_v1';
const photoMemoryCache = new Map();
let photoCacheDbPromise = null;
let photoCryptoKeyPromise = null;

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function openPhotoCacheDb() {
    if (!window.indexedDB) return Promise.reject(new Error('IndexedDB not available'));
    if (photoCacheDbPromise) return photoCacheDbPromise;
    photoCacheDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(PHOTO_CACHE_DB, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(PHOTO_CACHE_STORE)) {
                db.createObjectStore(PHOTO_CACHE_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return photoCacheDbPromise;
}

function getPhotoCryptoKey() {
    if (photoCryptoKeyPromise) return photoCryptoKeyPromise;
    if (!window.crypto || !window.crypto.subtle) {
        return Promise.reject(new Error('Web Crypto not available'));
    }
    photoCryptoKeyPromise = (async () => {
        let rawKeyBase64 = safeStorage.getItem(PHOTO_CACHE_KEY_STORAGE);
        if (!rawKeyBase64) {
            const raw = new Uint8Array(32);
            window.crypto.getRandomValues(raw);
            rawKeyBase64 = bytesToBase64(raw);
            safeStorage.setItem(PHOTO_CACHE_KEY_STORAGE, rawKeyBase64);
        }
        const rawKey = base64ToBytes(rawKeyBase64);
        return window.crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
    })();
    return photoCryptoKeyPromise;
}

async function getPhotoCacheEntry(cacheKey) {
    const db = await openPhotoCacheDb();
    return new Promise((resolve) => {
        const tx = db.transaction(PHOTO_CACHE_STORE, 'readonly');
        const store = tx.objectStore(PHOTO_CACHE_STORE);
        const req = store.get(cacheKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
    });
}

async function setPhotoCacheEntry(cacheKey, entry) {
    const db = await openPhotoCacheDb();
    return new Promise((resolve) => {
        const tx = db.transaction(PHOTO_CACHE_STORE, 'readwrite');
        const store = tx.objectStore(PHOTO_CACHE_STORE);
        const req = store.put(entry, cacheKey);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
    });
}

async function encryptPhotoBytes(bytes) {
    const key = await getPhotoCryptoKey();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return {
        iv: bytesToBase64(iv),
        data: bytesToBase64(new Uint8Array(encrypted))
    };
}

async function decryptPhotoBytes(entry) {
    const key = await getPhotoCryptoKey();
    const iv = base64ToBytes(entry.iv);
    const data = base64ToBytes(entry.data);
    const decrypted = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new Uint8Array(decrypted);
}

async function getEncryptedPhotoUrl(cacheKey) {
    if (!cacheKey) return null;
    if (photoMemoryCache.has(cacheKey)) {
        return photoMemoryCache.get(cacheKey);
    }
    const entry = await getPhotoCacheEntry(cacheKey);
    if (!entry) return null;
    const bytes = await decryptPhotoBytes(entry);
    const blob = new Blob([bytes], { type: entry.type || 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    photoMemoryCache.set(cacheKey, url);
    return url;
}

async function cachePhotoFromUrl(cacheKey, photoUrl) {
    if (!cacheKey || !photoUrl) return;
    if (photoUrl.startsWith('data:')) return;
    const response = await fetch(photoUrl, { mode: 'cors' });
    if (!response.ok) {
        throw new Error('Failed to fetch photo');
    }
    const buffer = await response.arrayBuffer();
    const encrypted = await encryptPhotoBytes(new Uint8Array(buffer));
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    await setPhotoCacheEntry(cacheKey, {
        iv: encrypted.iv,
        data: encrypted.data,
        type: contentType,
        ts: Date.now()
    });
}

async function applyEncryptedPhotoToImg(imgEl, photoUrl, cacheKey) {
    if (!imgEl || !photoUrl) return;
    const key = cacheKey || photoUrl;
    if (!window.crypto?.subtle || !window.indexedDB) {
        imgEl.src = photoUrl;
        return;
    }
    try {
        const cachedUrl = await getEncryptedPhotoUrl(key);
        if (cachedUrl) {
            imgEl.src = cachedUrl;
            return;
        }
    } catch (e) {
        // Ignore cache errors, fallback to remote URL
    }
    imgEl.src = photoUrl;
    cachePhotoFromUrl(key, photoUrl).catch(() => { });
}

const LOGIN_EMAIL_KEY = 'rollcall_login_email';

// User cache (device storage)
const USER_CACHE_PREFIX = 'rollcall_user_cache_v1:';
const USER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function getCachedUserData(uid) {
    if (!uid) return null;
    try {
        const raw = safeStorage.getItem(`${USER_CACHE_PREFIX}${uid}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.data || !parsed.ts) return null;
        if (Date.now() - parsed.ts > USER_CACHE_TTL_MS) return null;
        return parsed.data;
    } catch (e) {
        return null;
    }
}

function cacheUserData(uid, data) {
    if (!uid || !data) return;
    try {
        safeStorage.setItem(`${USER_CACHE_PREFIX}${uid}`, JSON.stringify({
            ts: Date.now(),
            data
        }));
    } catch (e) {
        // Ignore cache write errors
    }
}

function saveLoginEmail(email) {
    const clean = (email || '').trim();
    if (!clean) return;
    safeStorage.setItem(LOGIN_EMAIL_KEY, clean);
}

function getSavedEmail() {
    const saved = safeStorage.getItem(LOGIN_EMAIL_KEY);
    return saved && typeof saved === 'string' ? saved : '';
}

// Lazy script loading for heavy libraries
const scriptLoaders = new Map();

function loadScriptOnce(src) {
    if (scriptLoaders.has(src)) {
        return scriptLoaders.get(src);
    }
    const loader = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${src}`));
        document.head.appendChild(script);
    });
    scriptLoaders.set(src, loader);
    return loader;
}

function ensureJsQrLoaded() {
    if (window.jsQR) return Promise.resolve();
    return loadScriptOnce('https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js');
}

function ensureFaceApiLoaded() {
    if (window.faceapi) return Promise.resolve();
    return loadScriptOnce('https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js');
}

let persistenceConfigured = false;
async function configureAuthPersistence() {
    if (persistenceConfigured) return;
    persistenceConfigured = true;
    const candidates = [
        indexedDBLocalPersistence,
        browserLocalPersistence,
        browserSessionPersistence
    ];
    for (const candidate of candidates) {
        try {
            await setPersistence(auth, candidate);
            console.log('Auth persistence set');
            return;
        } catch (error) {
            console.warn('Auth persistence unavailable, trying fallback:', error);
        }
    }
    console.warn('Auth persistence could not be set; defaulting to in-memory.');
}

let notificationPermissionRequested = false;

function tryNativeNotification(title, body) {
    try {
        if (window.AndroidDevice) {
            if (typeof window.AndroidDevice.showNotification === 'function') {
                window.AndroidDevice.showNotification(title, body);
                return true;
            }
            if (typeof window.AndroidDevice.notify === 'function') {
                window.AndroidDevice.notify(title, body);
                return true;
            }
            if (typeof window.AndroidDevice.sendNotification === 'function') {
                window.AndroidDevice.sendNotification(title, body);
                return true;
            }
        }
    } catch (error) {
        console.warn('Native notification failed:', error);
    }
    return false;
}

window.rollcallNotifyNative = tryNativeNotification;

async function showAttendanceNotification(title, body) {
    if (tryNativeNotification(title, body)) {
        return true;
    }

    if (!('Notification' in window)) {
        return false;
    }

    if (Notification.permission === 'granted') {
        new Notification(title, { body, tag: 'attendance' });
        return true;
    }

    if (Notification.permission === 'default' && !notificationPermissionRequested) {
        notificationPermissionRequested = true;
        try {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                new Notification(title, { body, tag: 'attendance' });
                return true;
            }
        } catch (error) {
            console.warn('Notification permission request failed:', error);
        }
    }

    return false;
}

function primeAttendanceNotificationPermission() {
    if (!('Notification' in window)) {
        return;
    }
    if (Notification.permission === 'default' && !notificationPermissionRequested) {
        notificationPermissionRequested = true;
        Notification.requestPermission().catch((error) => {
            console.warn('Notification permission request failed:', error);
        });
    }
}

function notifyAttendanceMarked(locationName, timestamp) {
    const time = new Date(timestamp || Date.now());
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const title = 'Attendance Marked';
    const body = locationName
        ? `Attendance marked for ${locationName} at ${timeStr}.`
        : `Attendance marked at ${timeStr}.`;

    showAttendanceNotification(title, body).catch(() => { });
}

// DOM Elements
const loginSection = document.getElementById('login-section');
const registerSection = document.getElementById('register-section');
const attendanceSection = document.getElementById('attendance-section');
const loginBtn = document.getElementById('login-btn');
const registerBtn = document.getElementById('register-btn');
const logoutBtn = document.getElementById('logout-btn');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const welcomeMessage = document.getElementById('welcome-message');
const userName = document.getElementById('user-name');
const captureBtn = document.getElementById('capture-btn');
const scanResult = document.getElementById('scan-result');
const resultMessage = document.getElementById('result-message');
const loginStatus = document.getElementById('login-status');
const registerStatus = document.getElementById('register-status');
const locationStatus = document.getElementById('location-status');
const registerLink = document.getElementById('register-link');
const loginLink = document.getElementById('login-link');
const regName = document.getElementById('reg-name');
const regEmail = document.getElementById('reg-email');
const regPassword = document.getElementById('reg-password');
const regPasswordConfirm = document.getElementById('reg-password-confirm');
const methodBadge = document.getElementById('method-badge');
const scannerContainer = document.getElementById('scanner-container');
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const scannerZoomControls = document.getElementById('scanner-zoom-controls');
const scannerZoomRange = document.getElementById('scanner-zoom-range');
const scannerZoomIn = document.getElementById('scanner-zoom-in');
const scannerZoomOut = document.getElementById('scanner-zoom-out');
const scannerZoomValue = document.getElementById('scanner-zoom-value');
const currentLatitude = document.getElementById('current-latitude');
const currentLongitude = document.getElementById('current-longitude');
const distanceInfo = document.getElementById('distance-info');
const locationInfo = document.getElementById('location-info');
const locationBadge = document.getElementById('location-badge');
const verificationBadges = document.getElementById('verification-badges');
const refreshClassesBtn = document.getElementById('refresh-classes-btn');
const loginProfileImg = document.getElementById('login-profile-img');
const loginAvatarContainer = document.querySelector('.avatar-container');
const DEFAULT_LOGIN_AVATAR_SRC = loginProfileImg ? loginProfileImg.getAttribute('src') : '';
window.rollcallAppModuleLoaded = true;

// Restore saved email for faster login
const savedEmail = getSavedEmail();
if (savedEmail) {
    emailInput.value = savedEmail;
}

// Device detection
const userAgent = navigator.userAgent || '';
const uaData = navigator.userAgentData || null;
const uaPlatform = (uaData && uaData.platform) ? uaData.platform : (navigator.platform || '');
const uaMobile = (uaData && typeof uaData.mobile === 'boolean') ? uaData.mobile : null;
const maxTouchPoints = navigator.maxTouchPoints || 0;
const hasTouchSupport = maxTouchPoints > 0;
const isAndroidUA = /Android/i.test(userAgent);
const isAndroidPlatform = /Android/i.test(uaPlatform);
const isAndroidDevice = isAndroidUA || isAndroidPlatform;
const isAppleTouchPlatform = /Mac/i.test(uaPlatform) && maxTouchPoints > 1;
const isIOSUA = /iPhone|iPad|iPod/i.test(userAgent);
const isIOSDevice = isIOSUA || isAppleTouchPlatform;
const isRollCallApp = typeof window.AndroidDevice !== 'undefined' && /RollCallWebView/i.test(userAgent);
const isIOSSafari = isIOSDevice && /Safari/i.test(userAgent) && !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/i.test(userAgent);
const isAndroidWeb = isAndroidDevice && !isRollCallApp;
const platformLooksDesktop = /Win|Mac|Linux|CrOS/i.test(uaPlatform);
const isDesktopLikePlatform = platformLooksDesktop && !isAppleTouchPlatform;
const finePointer = window.matchMedia ? window.matchMedia('(pointer: fine)').matches : false;
const hoverHover = window.matchMedia ? window.matchMedia('(hover: hover)').matches : false;

const desktopSignals = [];
if (uaMobile === false) desktopSignals.push('uaMobileFalse');
if (!hasTouchSupport) desktopSignals.push('noTouch');
if (finePointer && hoverHover) desktopSignals.push('finePointer');
const isDesktopSignalStrong = desktopSignals.length >= 2;
const isLikelyDesktopEmulation = uaMobile === false && (platformLooksDesktop || (!isAndroidDevice && !isIOSDevice));

function isDesktopAttendanceRestricted() {
    if (isRollCallApp) return false;
    if (isDesktopLikePlatform) return true;
    if (isLikelyDesktopEmulation) return true;
    if (isDesktopSignalStrong) return true;
    if (!isAndroidDevice && !isIOSDevice) return true;
    return false;
}

const IOS_LOCAL_LOCK_KEY = 'rollcall_ios_device_lock_v1';
const IOS_LOCAL_LOCK_WINDOW_MS = 30 * 60 * 1000;

function canPersistIosLocalLock() {
    return isIOSDevice && window.safeStorage && safeStorage.type === 'local';
}

function getIosLocalLock() {
    if (!canPersistIosLocalLock()) return null;
    const raw = safeStorage.getItem(IOS_LOCAL_LOCK_KEY);
    if (!raw) return null;
    let lock = null;
    try {
        lock = JSON.parse(raw);
    } catch (error) {
        safeStorage.removeItem(IOS_LOCAL_LOCK_KEY);
        return null;
    }
    if (!lock || typeof lock !== 'object') {
        safeStorage.removeItem(IOS_LOCAL_LOCK_KEY);
        return null;
    }
    const expiresAt = Number(lock.expiresAt || 0);
    if (expiresAt && Date.now() >= expiresAt) {
        safeStorage.removeItem(IOS_LOCAL_LOCK_KEY);
        return null;
    }
    return lock;
}

function setIosLocalLock(lock) {
    if (!canPersistIosLocalLock()) return;
    try {
        safeStorage.setItem(IOS_LOCAL_LOCK_KEY, JSON.stringify(lock));
    } catch (error) {
        console.warn('Unable to persist iOS local lock:', error);
    }
}

function clearIosLocalLock() {
    if (!window.safeStorage) return;
    safeStorage.removeItem(IOS_LOCAL_LOCK_KEY);
}

function showStorageClearWarning() {
    showLoginStatus('Please do not clear browser storage, otherwise you will be permanently blocked.', 'warning');
}

function blockUserForStorageClear(user, reason) {
    const userRef = ref(database, `users/${user.uid}`);
    update(userRef, {
        blocked: true,
        blockedReason: reason,
        blockedAt: Date.now()
    }).catch((error) => console.error('Error blocking user after storage clear:', error));

    showLoginStatus('Account blocked due to missing device lock. Contact your teacher.', 'error');

    if (loginBtn) {
        loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
        loginBtn.disabled = false;
    }

    cleanupAttendanceListener();
    stopLocationTracking();
    signOut(auth);
    return true;
}

// Cleanup expired iOS local lock on load
getIosLocalLock();

// Device lock profile management
const DEVICE_LOCK_PROFILE_KEY = 'rollcall_device_lock_profile_v1';
const DEVICE_LOCK_PROFILE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getDeviceLockProfile() {
    try {
        const raw = safeStorage.getItem(DEVICE_LOCK_PROFILE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.data || !parsed.ts) return null;
        if (Date.now() - parsed.ts > DEVICE_LOCK_PROFILE_TTL_MS) {
            safeStorage.removeItem(DEVICE_LOCK_PROFILE_KEY);
            return null;
        }
        return parsed.data;
    } catch (e) {
        return null;
    }
}

function setDeviceLockProfile(profileData) {
    if (!profileData) return;
    try {
        safeStorage.setItem(DEVICE_LOCK_PROFILE_KEY, JSON.stringify({
            ts: Date.now(),
            data: profileData
        }));
    } catch (e) {
        // Ignore cache write errors
    }
}

function clearDeviceLockProfile() {
    safeStorage.removeItem(DEVICE_LOCK_PROFILE_KEY);
}

function resetLoginAvatar() {
    if (loginProfileImg && DEFAULT_LOGIN_AVATAR_SRC) {
        loginProfileImg.src = DEFAULT_LOGIN_AVATAR_SRC;
    }
    if (loginAvatarContainer) {
        const nameDisplay = loginAvatarContainer.querySelector('.device-lock-name');
        if (nameDisplay) {
            nameDisplay.remove();
        }
    }
}

async function renderDeviceLockProfile(lockProfile) {
    if (!lockProfile) {
        resetLoginAvatar();
        return;
    }

    if (lockProfile.profilePhoto && loginProfileImg) {
        await applyEncryptedPhotoToImg(
            loginProfileImg,
            lockProfile.profilePhoto,
            lockProfile.profilePhotoKey || lockProfile.profilePhoto
        );
    } else if (loginProfileImg && DEFAULT_LOGIN_AVATAR_SRC) {
        loginProfileImg.src = DEFAULT_LOGIN_AVATAR_SRC;
    }

    if (loginAvatarContainer) {
        let nameDisplay = loginAvatarContainer.querySelector('.device-lock-name');
        if (!lockProfile.name) {
            if (nameDisplay) nameDisplay.remove();
        } else {
            if (!nameDisplay) {
                nameDisplay = document.createElement('div');
                nameDisplay.className = 'device-lock-name';
                nameDisplay.style.cssText = `
                            text-align: center;
                            margin-top: 10px;
                            font-size: 0.9rem;
                            font-weight: 600;
                            color: var(--primary-color);
                            opacity: 0.8;
                        `;
                loginAvatarContainer.appendChild(nameDisplay);
            }
            nameDisplay.textContent = lockProfile.name;
        }
    }

    if (lockProfile.email && emailInput && !emailInput.value) {
        emailInput.value = lockProfile.email;
    }
}

async function getActiveDeviceLock() {
    if (!deviceId) {
        deviceId = generateDeviceId();
    }
    if (!deviceFingerprint) {
        deviceFingerprint = generateDeviceFingerprint();
    }

    const deviceLockRef = ref(database, `deviceLocks/${deviceId}`);
    const fingerprintLockRef = ref(database, `deviceFingerprintLocks/${deviceFingerprint}`);
    const [deviceSnap, fingerprintSnap] = await Promise.all([
        get(deviceLockRef),
        get(fingerprintLockRef)
    ]);

    const now = Date.now();
    const lockWindowMs = DEVICE_LOCK_PROFILE_TTL_MS;
    const candidates = [
        { lock: deviceSnap.val(), ref: deviceLockRef },
        { lock: fingerprintSnap.val(), ref: fingerprintLockRef }
    ];

    let active = null;
    candidates.forEach(({ lock, ref: lockRef }) => {
        if (!lock || !lock.attendanceTime) return;
        const age = now - lock.attendanceTime;
        if (age < lockWindowMs) {
            if (!active || age < active.age) {
                active = { lock, age };
            }
        } else {
            remove(lockRef).catch(error => console.error('Error removing expired lock:', error));
        }
    });

    return active ? active.lock : null;
}

async function loadDeviceLockProfile() {
    try {
        const activeLock = await getActiveDeviceLock();
        if (!activeLock || !activeLock.userId) {
            clearDeviceLockProfile();
            resetLoginAvatar();
            return;
        }

        const cachedProfile = getDeviceLockProfile();
        if (cachedProfile && cachedProfile.uid === activeLock.userId) {
            await renderDeviceLockProfile(cachedProfile);
            return;
        }

        const userSnap = await get(ref(database, `users/${activeLock.userId}`));
        const fallbackEmail = activeLock.userEmail || '';
        const fallbackName = fallbackEmail ? fallbackEmail.split('@')[0] : 'User';

        let profileData = {
            uid: activeLock.userId,
            email: fallbackEmail,
            name: fallbackName,
            profilePhoto: null,
            profilePhotoKey: null
        };

        if (userSnap.exists()) {
            const userData = userSnap.val();
            profileData = {
                uid: activeLock.userId,
                email: userData.email || fallbackEmail,
                name: userData.name || fallbackName,
                profilePhoto: userData.profilePhoto || null,
                profilePhotoKey: userData.profilePhotoKey || userData.profilePhoto || null
            };
        }

        setDeviceLockProfile(profileData);
        await renderDeviceLockProfile(profileData);
    } catch (error) {
        console.error('Error loading device lock profile:', error);
        resetLoginAvatar();
    }
}

function updateDeviceLockProfile(user, userData) {
    if (!user || !userData) return;

    const profileData = {
        uid: user.uid,
        email: userData.email || user.email,
        name: userData.name,
        profilePhoto: userData.profilePhoto,
        profilePhotoKey: userData.profilePhotoKey
    };

    setDeviceLockProfile(profileData);
}

const performanceMode = isRollCallApp || (isAndroidDevice && Number(navigator.hardwareConcurrency || 0) <= 4);
if (performanceMode) {
    document.documentElement.classList.add('performance-mode');
}

const AUTO_REFRESH_INTERVAL_MS = performanceMode ? 60000 : 30000;
const QR_MODAL_SCAN_INTERVAL_MS = performanceMode ? 350 : 250;
const QR_CAMERA_SCAN_INTERVAL_MS = performanceMode ? 800 : 550;
const FACE_DETECT_INTERVAL_MS = performanceMode ? 900 : 500;
const QR_SCAN_MAX_DIMENSION = performanceMode ? 360 : 480;
const CAMERA_IDEAL_WIDTH = performanceMode ? 960 : 1280;
const CAMERA_IDEAL_HEIGHT = performanceMode ? 540 : 720;

configureAuthPersistence();

// Global variables
let currentUser = null;
let deviceId = generateDeviceId(); // Generate device ID immediately
let deviceFingerprint = generateDeviceFingerprint(); // Cross-browser device fingerprint
let lastLoginTime = null;

// Load cached/locked profile for device lock
loadDeviceLockProfile();
let scanning = false;
let scanIntervalId = null;
let currentPosition = null;
let watchPositionId = null;
let classLocations = [];
let nearbyLocation = null;
let cameraActive = false;  // Track if camera is already active
let scannerZoomInfo = { value: 1, mode: 'none' };
let qrZoomInfo = { value: 1, mode: 'none' };
let scannerZoomController = null;
let qrZoomController = null;
let autoRefreshInterval = null;
let isLocationTracking = false;
let attendedClasses = new Set();
let attendedClassesData = new Map();
let displayedClasses = new Set();

// Log device ID for debugging
console.log('Device ID initialized:', deviceId);

// Login functionality
loginBtn.addEventListener('click', async () => {
    try {
        const email = emailInput.value;
        const password = passwordInput.value;

        loginStatus.classList.add('hidden');

        if (!email || !password) {
            showLoginStatus('Please enter both email and password', 'error');
            return;
        }

        saveLoginEmail(email);

        if (isIOSDevice && !isIOSSafari) {
            showLoginStatus('On iPhone, please use Safari to log in.', 'error');
            return;
        }

        // Show loading spinner
        loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Signing in...';
        loginBtn.disabled = true;

        await configureAuthPersistence();

        const canLogin = await ensureDeviceUnlockedForEmail(email);
        if (!canLogin) {
            loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
            loginBtn.disabled = false;
            return;
        }

        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        showLoginStatus('Credentials verified with Firebase. Checking device access...', 'info');
        // Check if this user is already logged in on another device
        checkDeviceLogin(userCredential.user);
    } catch (error) {
        const message = error && error.message ? error.message : 'Unknown sign-in error.';
        showLoginStatus(`Login failed: ${message}`, 'error');
        loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
        loginBtn.disabled = false;
    }
});
window.rollcallLoginReady = true;

// Register functionality
registerBtn.addEventListener('click', () => {
    if (registrationLiveStatus !== true) {
        showRegisterStatus('Registrations are currently closed. Please try later.', 'error');
        lockRegisterButton('<i class="fas fa-lock"></i> Registrations Closed');
        return;
    }
    const name = regName.value;
    const email = regEmail.value;
    const classRoll = document.getElementById('reg-class-roll').value;
    const univRoll = document.getElementById('reg-univ-roll').value;
    const section = document.getElementById('reg-section').value;
    const mobile = document.getElementById('reg-mobile').value;
    const course = document.getElementById('reg-course').value;
    const password = regPassword.value;
    const passwordConfirm = regPasswordConfirm.value;

    // DEBUG: Log all values directly from DOM elements
    console.log("Direct DOM element values:");
    console.log("reg-class-roll element:", document.getElementById('reg-class-roll'));
    console.log("reg-class-roll value:", document.getElementById('reg-class-roll').value);
    console.log("reg-univ-roll element:", document.getElementById('reg-univ-roll'));
    console.log("reg-univ-roll value:", document.getElementById('reg-univ-roll').value);

    console.log("Registration values:", {
        name, email, classRoll, univRoll, section,
        password: "******", passwordConfirm: "******"
    });

    if (!profileImageFile) {
        showRegisterStatus('Please upload a profile photo', 'error');
        // Highlight the photo upload area
        const previewWrapper = document.getElementById('photo-preview-wrapper');
        previewWrapper.style.border = '4px solid var(--danger-color)';
        previewWrapper.style.animation = 'shake 0.5s ease';
        setTimeout(() => {
            previewWrapper.style.border = '4px solid var(--primary-color)';
            previewWrapper.style.animation = '';
        }, 2000);
        return;
    }

    if (!name || !email || !classRoll || !univRoll || !section || !mobile || !course || !password || !passwordConfirm) {
        showRegisterStatus('Please fill in all fields', 'error');
        return;
    }

    if (!/^[0-9]{10}$/.test(mobile)) {
        showRegisterStatus('Mobile number must be exactly 10 digits', 'error');
        return;
    }

    if (password !== passwordConfirm) {
        showRegisterStatus('Passwords do not match', 'error');
        return;
    }

    if (!/^[0-9]{2}$/.test(classRoll)) {
        showRegisterStatus('Class roll number must be exactly 2 digits', 'error');
        return;
    }

    if (!/^[0-9]{10}$/.test(univRoll)) {
        showRegisterStatus('University roll number must be exactly 10 digits', 'error');
        return;
    }

    // Show loading spinner
    registerBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating account...';
    registerBtn.disabled = true;

    // Check if email, university roll, or class roll already exists
    const usersRef = ref(database, 'users');

    get(usersRef)
        .then((snapshot) => {
            // DEBUG: Log snapshot exists
            console.log("Users snapshot exists:", snapshot.exists());

            if (snapshot.exists()) {
                const users = snapshot.val();
                let emailExists = false;
                let univRollExists = false;
                let classRollExists = false;

                // Check each user
                Object.values(users).forEach(user => {
                    if (user.email && user.email.toLowerCase() === email.toLowerCase()) {
                        emailExists = true;
                    }

                    if (user.univRoll && user.univRoll === univRoll) {
                        univRollExists = true;
                    }

                    // Check class roll only if section matches
                    if (user.classRoll && user.classRoll === classRoll &&
                        user.section && user.section.toLowerCase() === section.toLowerCase()) {
                        classRollExists = true;
                    }
                });

                // DEBUG: Log existence checks
                console.log("Existence checks:", { emailExists, univRollExists, classRollExists });

                // Show appropriate error message
                if (emailExists) {
                    showRegisterStatus('This email address is already registered', 'error');
                    registerBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
                    registerBtn.disabled = false;
                    return;
                }

                if (univRollExists) {
                    showRegisterStatus('This university roll number is already registered', 'error');
                    registerBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
                    registerBtn.disabled = false;
                    return;
                }

                if (classRollExists) {
                    showRegisterStatus('This class roll number is already registered for this section', 'error');
                    registerBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
                    registerBtn.disabled = false;
                    return;
                }
            }

            // DEBUG: Log before user creation
            console.log("About to create user with email:", email);

            // Define user data before creating the user
            const classRollValue = document.getElementById('reg-class-roll').value;
            const univRollValue = document.getElementById('reg-univ-roll').value;
            const nameValue = document.getElementById('reg-name').value;

            console.log("Final values before user creation - name:", nameValue, "classRoll:", classRollValue, "univRoll:", univRollValue);

            // If all checks pass, create the user
            isRegistering = true;
            createUserWithEmailAndPassword(auth, email, password)
                .then((userCredential) => {
                    const user = userCredential.user;

                    // DEBUG: Log user created
                    console.log("User created:", user.uid);

                    // IMPORTANT: Store the name from the form
                    const fullName = regName.value;

                    // Update the user's profile with the display name
                    updateProfile(user, {
                        displayName: fullName
                    }).then(() => {
                        console.log("User profile updated with display name:", fullName);
                    }).catch((error) => {
                        console.error("Error updating user profile:", error);
                    });

                    // Get final values directly from DOM again to ensure they're fresh
                    const finalClassRoll = document.getElementById('reg-class-roll').value;
                    const finalUnivRoll = document.getElementById('reg-univ-roll').value;

                    console.log("FINAL VALUES:", {
                        name: fullName, // Use the direct value from regName
                        classRoll: finalClassRoll,
                        univRoll: finalUnivRoll,
                        section: section
                    });

                    // Create a minimal userData object first
                    const basicUserData = {
                        uid: user.uid,
                        email: email,
                        name: fullName, // Use the direct value from regName
                        role: "student",
                        createdAt: new Date().toISOString()
                    };

                    // Save basic user data first
                    set(ref(database, `users/${user.uid}`), basicUserData)
                        .then(async () => {
                            console.log("Basic user data saved successfully");

                            // Now update with the roll numbers and additional fields separately
                            let uploadResult = null;
                            try {
                                uploadResult = await uploadProfilePhoto(profileImageFile, user.uid);
                            } catch (error) {
                                console.error("Profile photo upload failed:", error);
                                showRegisterStatus('Profile photo upload failed. Please try again.', 'error');
                                registerBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
                                registerBtn.disabled = false;
                                isRegistering = false;
                                signOut(auth).catch(() => { });
                                error._handled = true;
                                throw error;
                            }

                            return update(ref(database, `users/${user.uid}`), {
                                "classRoll": finalClassRoll,
                                "univRoll": finalUnivRoll,
                                "section": section,
                                "mobile": mobile,
                                "course": course,
                                "profilePhoto": uploadResult.publicUrl,
                                "profilePhotoKey": uploadResult.key || null,
                                "profilePhotoUpdatedAt": Date.now()
                            });
                        })
                        .then(() => {
                            console.log("Roll numbers updated successfully");

                            // Verify data was saved correctly
                            get(ref(database, `users/${user.uid}`))
                                .then((snapshot) => {
                                    console.log("VERIFICATION - Final user data:", snapshot.val());

                                    showRegisterStatus('Registration successful! Please sign in.', 'success');
                                    signOut(auth)
                                        .then(() => {
                                            showLoginSection();
                                            showLoginStatus('Account created. Please sign in.', 'success');
                                        })
                                        .catch(() => {
                                            showLoginSection();
                                            showLoginStatus('Account created. Please sign in.', 'success');
                                        })
                                        .finally(() => {
                                            registerBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
                                            registerBtn.disabled = false;
                                            isRegistering = false;
                                        });
                                })
                                .catch(error => {
                                    console.error("Verification error:", error);
                                });
                        })
                        .catch((error) => {
                            if (error && error._handled) {
                                return;
                            }
                            console.error("Error saving user data:", error);
                            showRegisterStatus(`User data saving failed: ${error.message}`, 'error');
                            // Reset register button
                            registerBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
                            registerBtn.disabled = false;
                            isRegistering = false;
                            signOut(auth).catch(() => { });
                        });
                })
                .catch((error) => {
                    // DEBUG: Log error creating user
                    console.error("Error creating user:", error);

                    showRegisterStatus(`Registration failed: ${error.message}`, 'error');
                    // Reset register button
                    registerBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
                    registerBtn.disabled = false;
                    isRegistering = false;
                });
        })
        .catch((error) => {
            // DEBUG: Log database check error
            console.error("Database check error:", error);

            showRegisterStatus(`Database check failed: ${error.message}`, 'error');
            // Reset register button
            registerBtn.innerHTML = '<i class="fas fa-user-plus"></i> Create Account';
            registerBtn.disabled = false;
            isRegistering = false;
        });
});

// Switch between login and registration
registerLink.addEventListener('click', (e) => {
    e.preventDefault();
    if (registrationLiveStatus !== true) {
        showLoginStatus('Registrations are currently closed.', 'error');
        lockRegisterButton('<i class="fas fa-lock"></i> Registrations Closed');
        return;
    }
    loginSection.classList.add('hidden');
    registerSection.classList.remove('hidden');
});

loginLink.addEventListener('click', (e) => {
    e.preventDefault();
    showLoginSection();
});

function showLoginSection() {
    registerSection.classList.add('hidden');
    loginSection.classList.remove('hidden');
}

async function ensureDeviceUnlockedForEmail(email) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!normalizedEmail) return true;

    if (!deviceId) {
        deviceId = generateDeviceId();
    }
    if (!deviceFingerprint) {
        deviceFingerprint = generateDeviceFingerprint();
    }

    const deviceLockRef = ref(database, `deviceLocks/${deviceId}`);
    const fingerprintLockRef = ref(database, `deviceFingerprintLocks/${deviceFingerprint}`);

    const [deviceSnap, fingerprintSnap] = await Promise.all([
        get(deviceLockRef),
        get(fingerprintLockRef)
    ]);

    const now = Date.now();
    const lockWindowMs = DEVICE_LOCK_PROFILE_TTL_MS;
    const locks = [deviceSnap.val(), fingerprintSnap.val()];
    let blockingLock = null;

    locks.forEach((lock) => {
        if (!lock || !lock.attendanceTime) return;
        const age = now - lock.attendanceTime;
        if (age >= lockWindowMs) return;

        const lockEmail = (lock.userEmail || '').trim().toLowerCase();
        if (lockEmail && lockEmail === normalizedEmail) {
            blockingLock = null;
            return;
        }

        if (!blockingLock || age < blockingLock.age) {
            blockingLock = { lock, age };
        }
    });

    if (!blockingLock) {
        return true;
    }

    const remainingMinutes = Math.ceil((lockWindowMs - blockingLock.age) / 60000);
    const lockedBy = blockingLock.lock && blockingLock.lock.userEmail
        ? blockingLock.lock.userEmail
        : 'another user';

    showLoginStatus(`ðŸ”’ This device is locked by ${lockedBy}. Please try again in ${remainingMinutes} minutes.`, 'error');
    if (isIOSDevice) {
        setTimeout(showStorageClearWarning, 1200);
    }

    return false;
}

// Logout functionality
logoutBtn.addEventListener('click', () => {
    logout();
});

if (refreshClassesBtn) {
    refreshClassesBtn.addEventListener('click', () => {
        refreshClasses();
    });
}

function logout() {
    // Simply sign out - don't remove device lock to maintain 30-minute restriction
    signOut(auth).then(() => {
        // Refresh the page after logout
        window.location.reload();
    }).catch((error) => {
        console.error("Error during logout:", error);
        // Refresh the page even if there was an error
        window.location.reload();
    });

    // Stop location tracking
    stopLocationTracking();
}

function stopLocationTracking() {
    // Stop camera and scanner
    if (cameraActive) {
        console.log("Stopping camera during location tracking shutdown");
        stopCamera();
    }

    // Stop auto-refresh
    stopAutoRefresh();

    // Stop location tracking
    if (watchPositionId) {
        navigator.geolocation.clearWatch(watchPositionId);
        watchPositionId = null;
    }
}

function enforceIosLocalLockOnReload(user) {
    if (!canPersistIosLocalLock()) return Promise.resolve(false);
    const userLockRef = ref(database, `userLocks/${user.uid}`);
    return get(userLockRef)
        .then((snapshot) => {
            if (!snapshot.exists()) return false;
            const userLock = snapshot.val();
            if (!userLock || !userLock.attendanceTime) return false;

            const now = Date.now();
            const timeSinceLock = now - userLock.attendanceTime;
            if (timeSinceLock >= IOS_LOCAL_LOCK_WINDOW_MS) {
                clearIosLocalLock();
                return false;
            }

            if (userLock.devicePlatform !== 'ios') return false;
            if (userLock.deviceFingerprint &&
                deviceFingerprint &&
                userLock.deviceFingerprint === deviceFingerprint) {
                const localLock = getIosLocalLock();
                if (!localLock || localLock.userId !== user.uid) {
                    const reason = 'Tried to login another account by clearing local storage.';
                    blockUserForStorageClear(user, reason);
                    return true;
                }
            }
            return false;
        })
        .catch((error) => {
            console.error('Error checking iOS local lock on reload:', error);
            return false;
        });
}

// Check if device is locked by another user or if user is locked on another device
function checkDeviceLogin(user) {
    // Generate a unique device ID if not already done
    if (!deviceId) {
        deviceId = generateDeviceId();
    }
    if (!deviceFingerprint) {
        deviceFingerprint = generateDeviceFingerprint();
    }

    console.log('Checking device and user locks for device:', deviceId, 'fingerprint:', deviceFingerprint, 'user:', user.uid);

    const deviceLockRef = ref(database, `deviceLocks/${deviceId}`);
    const fingerprintLockRef = ref(database, `deviceFingerprintLocks/${deviceFingerprint}`);
    const userLockRef = ref(database, `userLocks/${user.uid}`);

    // Check both device locks and user locks
    Promise.all([get(deviceLockRef), get(fingerprintLockRef), get(userLockRef)])
        .then(([deviceSnapshot, fingerprintSnapshot, userSnapshot]) => {
            const deviceLock = deviceSnapshot.val();
            const fingerprintLock = fingerprintSnapshot.val();
            const userLock = userSnapshot.val();
            const currentTime = new Date().getTime();
            const thirtyMinutes = 30 * 60 * 1000; // 30 minutes in milliseconds

            console.log('Device lock data:', deviceLock);
            console.log('Fingerprint lock data:', fingerprintLock);
            console.log('User lock data:', userLock);

            // Check if device (including cross-browser fingerprint) is locked by another user
            const lockCandidates = [
                { lock: deviceLock, ref: deviceLockRef, label: 'device' },
                { lock: fingerprintLock, ref: fingerprintLockRef, label: 'fingerprint' }
            ];
            let blockingLock = null;

            lockCandidates.forEach(({ lock, ref, label }) => {
                if (lock && lock.attendanceTime) {
                    const timeSinceLock = currentTime - lock.attendanceTime;
                    console.log(`${label} lock - Time since lock:`, timeSinceLock, 'minutes:', Math.floor(timeSinceLock / 60000));

                    if (timeSinceLock < thirtyMinutes) {
                        if (lock.userId === user.uid) {
                            console.log(`Same user logging back into their locked ${label} - allowing login`);
                        } else if (!blockingLock || timeSinceLock < blockingLock.timeSinceLock) {
                            blockingLock = { lock, timeSinceLock };
                        }
                    } else {
                        console.log(`${label} lock expired, removing`);
                        remove(ref).catch(error => console.error(`Error removing expired ${label} lock:`, error));
                    }
                }
            });

            if (blockingLock) {
                const remainingMinutes = Math.ceil((thirtyMinutes - blockingLock.timeSinceLock) / 60000);
                console.log('Device is locked by another user! Remaining minutes:', remainingMinutes);

                showLoginStatus(`ðŸ”’ This device is locked by another user (${blockingLock.lock.userEmail}). Please try again in ${remainingMinutes} minutes.`, 'error');
                if (isIOSDevice) {
                    setTimeout(showStorageClearWarning, 1200);
                }

                // Reset login button
                loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
                loginBtn.disabled = false;

                cleanupAttendanceListener();
                stopLocationTracking();

                // Sign out the current user
                signOut(auth);
                return;
            }

            // Check if user is trying to login on a different device
            if (userLock && userLock.attendanceTime) {
                const timeSinceLock = currentTime - userLock.attendanceTime;
                const sameDeviceByFingerprint = userLock.deviceFingerprint &&
                    deviceFingerprint &&
                    userLock.deviceFingerprint === deviceFingerprint;
                const iosAllowWithoutFingerprint = isIOSDevice && !userLock.deviceFingerprint;

                if (timeSinceLock < thirtyMinutes &&
                    userLock.devicePlatform === 'ios' &&
                    isIOSDevice &&
                    userLock.deviceFingerprint &&
                    sameDeviceByFingerprint) {
                    const localLock = getIosLocalLock();
                    if (!localLock || localLock.userId !== user.uid) {
                        const reason = 'Tried to login another account by clearing local storage.';
                        blockUserForStorageClear(user, reason);
                        return;
                    }
                }

                if (timeSinceLock < thirtyMinutes &&
                    userLock.deviceId !== deviceId &&
                    !sameDeviceByFingerprint &&
                    !iosAllowWithoutFingerprint) {
                    // User is trying to login on a different device - prevent this
                    const remainingMinutes = Math.ceil((thirtyMinutes - timeSinceLock) / 60000);

                    showLoginStatus(`ðŸ”’ You cannot switch devices for ${remainingMinutes} more minutes after marking attendance. Please use the original device.`, 'error');
                    if (isIOSDevice) {
                        setTimeout(showStorageClearWarning, 1200);
                    }

                    // Reset login button
                    loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
                    loginBtn.disabled = false;

                    cleanupAttendanceListener();
                    stopLocationTracking();

                    // Sign out the current user
                    signOut(auth);
                    return;
                } else if (timeSinceLock >= thirtyMinutes) {
                    console.log('User lock has expired, removing old lock');
                    remove(userLockRef).catch(error => console.error('Error removing expired user lock:', error));
                    if (isIOSDevice) {
                        clearIosLocalLock();
                    }
                }
            }

            console.log('All lock checks passed - proceeding with login');

            // All checks passed, proceed with login
            showLoginStatus('Access verified. Loading your app...', 'success');
            getUserData(user);

            // Update device lock profile for future logins
            get(ref(database, `users/${user.uid}`)).then((snapshot) => {
                if (snapshot.exists()) {
                    updateDeviceLockProfile(user, snapshot.val());
                }
            }).catch(() => { });
        })
        .catch((error) => {
            console.error('Lock check error:', error);
            showLoginStatus(`Login check failed: ${error.message}`, 'error');
            // Reset login button
            loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
            loginBtn.disabled = false;
        });
}

// Get native Android device ID when available (WebView bridge)
function getNativeDeviceId() {
    try {
        if (window.AndroidDevice && typeof window.AndroidDevice.getDeviceId === 'function') {
            const nativeId = window.AndroidDevice.getDeviceId();
            if (nativeId && typeof nativeId === 'string') {
                return `android_${nativeId}`;
            }
        }
    } catch (error) {
        console.warn('Native device ID unavailable:', error);
    }
    return null;
}

// Generate a unique device ID
function generateDeviceId() {
    const nativeId = getNativeDeviceId();
    if (nativeId) {
        try {
            safeStorage.setItem('rollcall_device_id', nativeId);
        } catch (error) {
            console.warn('Failed to store native device ID:', error);
        }
        return nativeId;
    }

    // Check if device ID is already stored in storage
    let storedDeviceId = safeStorage.getItem('rollcall_device_id');
    if (storedDeviceId) {
        return storedDeviceId;
    }

    // Use browser and device specific information to create a unique ID
    const nav = window.navigator;
    const screen = window.screen;
    const browserInfo = nav.userAgent + nav.language;
    const screenInfo = screen.height + screen.width + screen.colorDepth + screen.pixelDepth;
    const timeInfo = new Date().getTimezoneOffset();
    const uniqueId = browserInfo + screenInfo + timeInfo + Date.now().toString();

    // Hash the ID or use base64 encoding for privacy
    const deviceId = btoa(uniqueId).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);

    // Store in storage for consistency
    safeStorage.setItem('rollcall_device_id', deviceId);

    return deviceId;
}

// Generate a cross-browser device fingerprint
function generateDeviceFingerprint() {
    const nativeId = getNativeDeviceId();
    if (nativeId) {
        return nativeId;
    }

    const nav = window.navigator || {};
    const screen = window.screen || {};
    const timeZone = (typeof Intl !== 'undefined' && Intl.DateTimeFormat)
        ? (Intl.DateTimeFormat().resolvedOptions().timeZone || '')
        : '';
    const fingerprintSource = [
        nav.platform || '',
        nav.language || '',
        (nav.languages || []).join(','),
        nav.hardwareConcurrency || '',
        nav.deviceMemory || '',
        nav.maxTouchPoints || '',
        screen.width || '',
        screen.height || '',
        screen.colorDepth || '',
        screen.pixelDepth || '',
        timeZone,
        new Date().getTimezoneOffset()
    ].join('|');

    const fingerprint = btoa(fingerprintSource).replace(/[^a-zA-Z0-9]/g, '').substring(0, 32);
    return fingerprint;
}

// Get user data from database
function getUserData(user) {
    const userRef = ref(database, `users/${user.uid}`);

    console.log("Getting user data for:", user.uid);
    console.log("Auth user displayName:", user.displayName);

    const cachedUser = getCachedUserData(user.uid);
    if (cachedUser) {
        currentUser = {
            uid: user.uid,
            email: cachedUser.email || user.email,
            name: cachedUser.name || user.displayName || user.email.split('@')[0],
            role: cachedUser.role || 'student',
            classRoll: cachedUser.classRoll,
            univRoll: cachedUser.univRoll,
            section: cachedUser.section,
            profilePhoto: cachedUser.profilePhoto || null,
            profilePhotoKey: cachedUser.profilePhotoKey || null
        };
        window.currentUser = currentUser;
    }

    get(userRef)
        .then((snapshot) => {
            console.log("User snapshot exists:", snapshot.exists());
            if (snapshot.exists()) {
                const userData = snapshot.val();
                console.log("Raw userData from database:", userData);

                // Log specifically the class roll and university roll values
                console.log("Class Roll from DB:", userData.classRoll);
                console.log("University Roll from DB:", userData.univRoll);

                // Check if we need to update the name field in the database to match the display name
                if (user.displayName && (!userData.name || userData.name === user.email.split('@')[0])) {
                    console.log("Updating name in database to use display name:", user.displayName);
                    update(userRef, { name: user.displayName });
                    userData.name = user.displayName;
                }

                // Store user data in global variable
                currentUser = {
                    uid: user.uid,
                    email: userData.email,
                    name: userData.name || user.displayName || user.email.split('@')[0],
                    role: userData.role || 'student',
                    classRoll: userData.classRoll,     // Make sure we're storing this
                    univRoll: userData.univRoll,       // Make sure we're storing this 
                    section: userData.section,
                    profilePhoto: userData.profilePhoto || null,
                    profilePhotoKey: userData.profilePhotoKey || null
                };

                // Update global window reference
                window.currentUser = currentUser;

                cacheUserData(user.uid, userData);
                updateDeviceLockProfile(user, userData);

                applyAndroidDownloadCreditsFromUserData(userData);

                // Persist email for faster login next time
                saveLoginEmail(currentUser.email || user.email || emailInput.value);

                console.log("Processed currentUser object:", currentUser);
                console.log("Class Roll in currentUser:", currentUser.classRoll);
                console.log("University Roll in currentUser:", currentUser.univRoll);

                // Check user role
                if (userData.role === 'admin') {
                    window.location.href = './admin';
                    return;
                }

                // Check if user is blocked
                if (userData.blocked === true) {
                    showBlockedUserPopup();
                    signOut(auth);
                    // Reset login button
                    loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
                    loginBtn.disabled = false;
                    return;
                }
                showAttendanceSection();
            } else {
                console.log("User exists in Auth but not in Database, creating basic profile");
                // User exists in Auth but not in Database
                // Create a basic profile

                // Get the display name from the auth user object if available
                // This ensures we use the name provided during registration
                const displayName = (user.displayName && user.displayName.trim()) ||
                    (regName && regName.value ? regName.value.trim() : '') ||
                    (user.email ? user.email.split('@')[0] : '') ||
                    'Student';
                console.log("Using display name for new user:", displayName);
                showLoginStatus('Credentials verified with Firebase. Creating your student profile...', 'info');

                set(ref(database, `users/${user.uid}`), {
                    uid: user.uid,
                    email: user.email,
                    name: displayName, // Use the display name instead of email username
                    role: 'student',
                    createdAt: new Date().toISOString()
                })
                    .then(() => {
                        console.log("Basic profile created successfully");
                        currentUser = {
                            uid: user.uid,
                            email: user.email,
                            name: displayName, // Use the display name here too
                            role: 'student'
                        };

                        // Update global window reference
                        window.currentUser = currentUser;
                        const basicUserData = {
                            uid: user.uid,
                            email: user.email,
                            name: displayName,
                            role: 'student'
                        };
                        cacheUserData(user.uid, basicUserData);
                        updateDeviceLockProfile(user, basicUserData);

                        applyAndroidDownloadCreditsFromUserData({});

                        // Persist email for faster login next time
                        saveLoginEmail(currentUser.email || user.email || emailInput.value);

                        showAttendanceSection();
                    })
                    .catch((error) => {
                        console.error("Error creating basic profile:", error);
                        showLoginStatus(`User profile creation failed: ${error.message}`, 'error');
                        loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
                        loginBtn.disabled = false;
                    });
            }
        })
        .catch((error) => {
            console.error("Error retrieving user data:", error);
            showLoginStatus(`User data retrieval failed: ${error.message}`, 'error');
            loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
            loginBtn.disabled = false;
        });
}

// Show attendance section
function showAttendanceSection() {
    loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In';
    loginBtn.disabled = false;
    loginStatus.classList.add('hidden');
    loginSection.classList.add('hidden');
    registerSection.classList.add('hidden');
    attendanceSection.classList.remove('hidden');

    // Update welcome message
    userName.textContent = currentUser.name;

    if (enforceAndroidAppOnly((msg) => showLocationStatus(msg, 'error'))) {
        stopLocationTracking();
        return;
    }

    // Load attended classes first, then start location tracking
    loadUserAttendedClasses().then(() => {
        startLocationTracking();
    });
}

function enforceAndroidAppOnly(messageHandler) {
    const isDesktopDevice = isDesktopAttendanceRestricted();
    if (desktopAttendanceBlocked && isDesktopDevice) {
        hideAndroidAppGate();
        hideAndroidDownloadModal();
        if (typeof messageHandler === 'function') {
            messageHandler('Attendance is disabled on desktop or emulated devices. Please use your phone.');
        }
        return true;
    }

    if (!isAndroidWeb) {
        hideAndroidAppGate();
        hideAndroidDownloadModal();
        return false;
    }

    showAndroidAppGate();
    // Main screen already shows the Android app notice; avoid extra popup.
    hideAndroidDownloadModal();
    if (typeof messageHandler === 'function') {
        messageHandler('Android users must use the RollCall app to mark attendance.');
    }
    return true;
}

function showAndroidAppGate() {
    const gate = document.getElementById('android-app-gate');
    if (gate) {
        gate.classList.remove('hidden');
    }
}

function hideAndroidAppGate() {
    const gate = document.getElementById('android-app-gate');
    if (gate) {
        gate.classList.add('hidden');
    }
}

let androidDownloadShown = false;
function showAndroidDownloadModal(force = false) {
    if (!isAndroidWeb) return;
    const modal = document.getElementById('android-download-modal');
    if (!modal) return;
    if (androidDownloadShown && !force) return;
    androidDownloadShown = true;
    modal.classList.add('visible');
}

function hideAndroidDownloadModal() {
    const modal = document.getElementById('android-download-modal');
    if (!modal) return;
    modal.classList.remove('visible');
}

const ANDROID_APP_DOWNLOAD_LIMIT = 1;
let androidDownloadCreditsRemaining = null;
const androidDownloadButtons = Array.from(document.querySelectorAll('.android-download-btn'));
const androidDownloadCreditNodes = [
    document.getElementById('android-download-credit'),
    document.getElementById('android-download-credit-gate')
].filter(Boolean);

function updateAndroidDownloadUI(remaining) {
    if (remaining === null || remaining === undefined) return;
    const limitReached = remaining <= 0;
    androidDownloadCreditNodes.forEach(node => {
        node.textContent = limitReached
            ? 'Download limit exceeded. Please contact admin.'
            : `Download credits left: ${remaining}/${ANDROID_APP_DOWNLOAD_LIMIT}`;
        node.style.color = limitReached ? '#ef4444' : '';
    });
    androidDownloadButtons.forEach(btn => {
        btn.classList.toggle('is-disabled', limitReached);
        btn.setAttribute('aria-disabled', String(limitReached));
        btn.dataset.disabled = limitReached ? 'true' : 'false';
    });
}

function applyAndroidDownloadCreditsFromUserData(userData) {
    const used = Number(userData?.appDownloadUsed || 0);
    androidDownloadCreditsRemaining = Math.max(ANDROID_APP_DOWNLOAD_LIMIT - used, 0);
    updateAndroidDownloadUI(androidDownloadCreditsRemaining);
}

function consumeAndroidDownloadCredit(userId) {
    const db = firebase.database();
    const usedRef = db.ref(`users/${userId}/appDownloadUsed`);
    return usedRef.transaction(current => {
        const used = Number(current || 0);
        if (used >= ANDROID_APP_DOWNLOAD_LIMIT) {
            return;
        }
        return used + 1;
    }).then(result => {
        if (!result.committed) {
            throw new Error('limit_reached');
        }
        const used = Number(result.snapshot.val() || 0);
        androidDownloadCreditsRemaining = Math.max(ANDROID_APP_DOWNLOAD_LIMIT - used, 0);
        updateAndroidDownloadUI(androidDownloadCreditsRemaining);
    });
}

function handleAndroidDownloadClick(event) {
    event.preventDefault();
    if (androidDownloadCreditsRemaining !== null && androidDownloadCreditsRemaining <= 0) {
        if (typeof showToast === 'function') {
            showToast('Download limit exceeded');
        } else {
            alert('Download limit exceeded');
        }
        return;
    }
    if (!currentUser || !currentUser.uid) {
        if (typeof showToast === 'function') {
            showToast('Please sign in to download');
        } else {
            alert('Please sign in to download');
        }
        return;
    }
    const target = event.currentTarget;
    const downloadUrl = target.getAttribute('href');
    consumeAndroidDownloadCredit(currentUser.uid)
        .then(() => {
            const anchor = document.createElement('a');
            anchor.href = downloadUrl;
            if (target.hasAttribute('download')) {
                anchor.setAttribute('download', target.getAttribute('download') || '');
            }
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
        })
        .catch(() => {
            if (typeof showToast === 'function') {
                showToast('Download limit exceeded');
            } else {
                alert('Download limit exceeded');
            }
        });
}

if (androidDownloadButtons.length) {
    androidDownloadButtons.forEach(btn => {
        btn.addEventListener('click', handleAndroidDownloadClick);
    });
}

// Expose modal helpers for non-module scripts
window.showAndroidDownloadModal = showAndroidDownloadModal;
window.hideAndroidDownloadModal = hideAndroidDownloadModal;

function cleanupAttendanceListener() {
    if (unsubscribeAttendance) {
        if (typeof unsubscribeAttendance === 'function') {
            unsubscribeAttendance();
        }
        unsubscribeAttendance = null;
    }
}

// Start continuous location tracking with auto-refresh
function startLocationTracking() {
    if (!auth.currentUser) {
        return;
    }
    if (navigator.geolocation) {
        isLocationTracking = true;
        showLocationStatus('Getting your location...', 'info');

        // Get initial position
        navigator.geolocation.getCurrentPosition(
            updatePosition,
            handleLocationError,
            { enableHighAccuracy: true, timeout: 15000 }
        );

        // Start auto-refresh every 30 seconds
        startAutoRefresh();
    } else {
        showLocationStatus("Geolocation is not supported by your browser.", 'error');
    }
}

// Start auto-refresh interval
function startAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
    }

    autoRefreshInterval = setInterval(() => {
        if (isLocationTracking && navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    // Update position silently without showing status messages
                    updatePositionSilently(position);
                },
                (error) => {
                    console.log('Auto-refresh location error:', error.message);
                    // Continue trying without showing errors
                },
                { enableHighAccuracy: true, timeout: 10000 }
            );
        }
    }, AUTO_REFRESH_INTERVAL_MS);
}

function refreshClasses() {
    if (enforceAndroidAppOnly((msg) => showLocationStatus(msg, 'error'))) {
        return;
    }

    if (!navigator.geolocation) {
        showLocationStatus("Geolocation is not supported by your browser.", 'error');
        return;
    }

    showLocationStatus('Refreshing classes...', 'info');
    navigator.geolocation.getCurrentPosition(
        updatePosition,
        handleLocationError,
        { enableHighAccuracy: true, timeout: 15000 }
    );
}

// Stop auto-refresh
function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
    isLocationTracking = false;
}

// Update position - keep location checking but remove map updates
function updatePosition(position) {
    currentPosition = position;
    window.currentPosition = position;
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;

    // Update UI
    currentLatitude.textContent = `Latitude: ${lat.toFixed(6)}`;
    currentLongitude.textContent = `Longitude: ${lng.toFixed(6)}`;
    locationInfo.classList.remove('hidden');

    // Load user's attended classes first
    loadUserAttendedClasses().then(() => {
        // Find nearby locations using a proximity-based approach
        findNearbyLocationsWithProximity(lat, lng);
    });

    // Hide status message
    locationStatus.classList.add('hidden');
}

// Silent position update for auto-refresh (doesn't show UI messages)
function updatePositionSilently(position) {
    currentPosition = position;
    window.currentPosition = position;
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;

    // Update coordinates display
    currentLatitude.textContent = `Latitude: ${lat.toFixed(6)}`;
    currentLongitude.textContent = `Longitude: ${lng.toFixed(6)}`;

    // Load user's attended classes and update nearby locations
    loadUserAttendedClasses().then(() => {
        findNearbyLocationsWithProximity(lat, lng);
    });
}

// Handle location error
function handleLocationError(error) {
    let message;

    switch (error.code) {
        case error.PERMISSION_DENIED:
            message = "Location access denied. Please enable location services and refresh the page.";
            showLocationStatus(message, 'error');
            stopAutoRefresh();
            return;
        case error.POSITION_UNAVAILABLE:
            message = "Location unavailable. Retrying...";
            break;
        case error.TIMEOUT:
            message = "Location timeout. Retrying...";
            break;
        default:
            message = "Location error. Retrying...";
            break;
    }

    showLocationStatus(message, 'warning');

    // Retry after a short delay
    setTimeout(() => {
        if (isLocationTracking) {
            navigator.geolocation.getCurrentPosition(
                updatePosition,
                handleLocationError,
                { enableHighAccuracy: true, timeout: 15000 }
            );
        }
    }, 3000);
}

// Convert degrees to radians
function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

// Function to normalize coordinates based on device type and accuracy
function normalizeCoordinates(lat, lon, accuracy = 0, deviceType = null) {
    // Validate inputs
    if (isNaN(lat) || isNaN(lon)) {
        console.error("Invalid coordinates for normalization:", lat, lon);
        return null;
    }

    // Parse coordinates as floats
    lat = parseFloat(lat);
    lon = parseFloat(lon);
    accuracy = parseFloat(accuracy) || 0;

    // Detect device type if not provided
    if (!deviceType) {
        deviceType = /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
    }

    // Calculate precision factor based on accuracy and device type
    let precisionFactor;
    if (deviceType === 'mobile') {
        // Mobile devices often have lower precision
        if (accuracy > 0) {
            // Use accuracy to determine precision
            precisionFactor = Math.max(4, 7 - Math.floor(Math.log10(accuracy)));
        } else {
            precisionFactor = 5; // Default for mobile
        }
    } else {
        // Desktop devices usually have better precision
        precisionFactor = 6;
    }

    // Round coordinates to determined precision
    const normalizedLat = parseFloat(lat.toFixed(precisionFactor));
    const normalizedLon = parseFloat(lon.toFixed(precisionFactor));

    console.log(`Normalized coordinates [${deviceType}]:`, {
        original: [lat, lon],
        normalized: [normalizedLat, normalizedLon],
        precision: precisionFactor,
        accuracy: accuracy
    });

    return {
        latitude: normalizedLat,
        longitude: normalizedLon,
        accuracy: accuracy,
        deviceType: deviceType
    };
}

// Function to calculate distance between two points with normalization
function calculateDistance(lat1, lon1, lat2, lon2, accuracy1 = 0, accuracy2 = 0) {
    // First normalize both sets of coordinates
    const coord1 = normalizeCoordinates(lat1, lon1, accuracy1);
    const coord2 = normalizeCoordinates(lat2, lon2, accuracy2);

    if (!coord1 || !coord2) {
        console.error("Failed to normalize coordinates");
        return Infinity;
    }

    // Use normalized coordinates for calculation
    const R = 6371000; // Earth radius in meters
    const dLat = deg2rad(coord2.latitude - coord1.latitude);
    const dLon = deg2rad(coord2.longitude - coord1.longitude);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(coord1.latitude)) * Math.cos(deg2rad(coord2.latitude)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    let distance = R * c;

    console.log(`Raw distance calculation: ${distance.toFixed(2)}m`);

    // If distance is extremely large (likely GPS error), apply super aggressive reduction
    if (distance > 50000) { // >50km is almost certainly an error
        console.log(`EXTREME DISTANCE DETECTED (${distance.toFixed(2)}m) - Using maximum reduction`);
        distance = Math.min(100, distance * 0.001); // Reduce to 0.1% with 100m maximum
        console.log(`After extreme reduction: ${distance.toFixed(2)}m`);
        return distance; // Return immediately with reduced distance
    }

    // Apply different reduction factors based on distance magnitude
    let distanceAdjustmentFactor = 1.0;

    if (distance > 10000) { // >10km
        distanceAdjustmentFactor = 0.02; // 98% reduction
        console.log(`Large distance (>10km): Applying 98% reduction`);
    } else if (distance > 5000) { // >5km
        distanceAdjustmentFactor = 0.05; // 95% reduction
        console.log(`Large distance (>5km): Applying 95% reduction`);
    } else if (distance > 1000) { // >1km
        distanceAdjustmentFactor = 0.1; // 90% reduction
        console.log(`Medium-large distance (>1km): Applying 90% reduction`);
    } else if (distance > 500) { // >500m
        distanceAdjustmentFactor = 0.2; // 80% reduction
        console.log(`Medium distance (>500m): Applying 80% reduction`);
    } else if (distance > 200) { // >200m
        distanceAdjustmentFactor = 0.3; // 70% reduction
        console.log(`Medium-small distance (>200m): Applying 70% reduction`);
    } else if (distance > 100) { // >100m
        distanceAdjustmentFactor = 0.4; // 60% reduction
        console.log(`Small distance (>100m): Applying 60% reduction`);
    } else if (distance > 50) { // >50m
        distanceAdjustmentFactor = 0.6; // 40% reduction
        console.log(`Very small distance (>50m): Applying 40% reduction`);
    } else {
        distanceAdjustmentFactor = 0.8; // 20% reduction
        console.log(`Tiny distance (<=50m): Applying 20% reduction`);
    }

    // Apply distance-based adjustment
    const distanceBeforeAdjustment = distance;
    distance *= distanceAdjustmentFactor;
    console.log(`After distance-based adjustment: ${distance.toFixed(2)}m (factor: ${distanceAdjustmentFactor})`);

    // Apply accuracy-based adjustment
    const combinedAccuracy = (coord1.accuracy + coord2.accuracy) / 2;
    if (combinedAccuracy > 0) {
        // More aggressive reduction for high-accuracy situations
        const accuracyFactor = Math.max(0.3, 1 - (combinedAccuracy / 50));
        const beforeAccuracyAdjustment = distance;
        distance *= accuracyFactor;
        console.log(`Applied accuracy adjustment: ${distance.toFixed(2)}m (factor: ${accuracyFactor}, combined accuracy: ${combinedAccuracy}m)`);
    }

    // Cross-device adjustment (apply last)
    if (coord1.deviceType !== coord2.deviceType) {
        console.log("Cross-device comparison detected, applying additional 50% reduction");
        const beforeCrossDeviceAdjustment = distance;
        // More aggressive adjustment for cross-device (50% reduction)
        distance *= 0.5;
        console.log(`After cross-device adjustment: ${distance.toFixed(2)}m (from ${beforeCrossDeviceAdjustment.toFixed(2)}m)`);
    }

    // Set a minimum reasonable distance to avoid false negatives
    // This ensures that even with all reductions, we don't go below a sensible threshold
    const minimumDistance = 5; // 5 meters minimum
    if (distance < minimumDistance) {
        console.log(`Distance below minimum threshold, setting to ${minimumDistance}m`);
        distance = minimumDistance;
    }

    // Log final calculation
    console.log("FINAL DISTANCE CALCULATION:", {
        originalCoords1: [lat1, lon1],
        originalCoords2: [lat2, lon2],
        normalized1: [coord1.latitude, coord1.longitude],
        normalized2: [coord2.latitude, coord2.longitude],
        rawDistance: R * c,
        adjustedDistance: distance,
        device1: coord1.deviceType,
        device2: coord2.deviceType,
        totalReductionFactor: distance / (R * c)
    });

    return distance;
}

// Function to check if user is near a location and display all available classes
function findNearbyLocationsWithProximity(lat, lng) {
    if (!lat || !lng) {
        console.log("No location data available");
        return;
    }
    if (!auth.currentUser) {
        return;
    }

    // Get all locations
    const locationsRef = ref(database, 'locations');

    get(locationsRef)
        .then((snapshot) => {
            if (snapshot.exists()) {
                const locations = snapshot.val();
                let nearbyLocations = []; // Array to store all nearby locations
                let allActiveLocations = []; // Array to store all active locations regardless of proximity

                console.log("Found " + Object.keys(locations).length + " locations to check");

                // Current time to check if location is active
                const now = new Date();

                // Check if we're on a mobile device
                const isMobile = /Mobi|Android/i.test(navigator.userAgent);
                console.log(`Device type: ${isMobile ? 'Mobile' : 'Desktop'}`);

                // Check each location
                for (const id in locations) {
                    const location = locations[id];

                    // Check if location has required fields
                    if (!location.latitude || !location.longitude || !location.radius) {
                        console.log(`Location ${location.name} is missing required fields`);
                        continue;
                    }

                    const scheduleInfo = getScheduleInfo(location);
                    const scheduledStart = scheduleInfo.start;
                    const hasScheduledStart = scheduleInfo.hasValue;
                    const isBeforeStart = hasScheduledStart && (!scheduledStart || now < scheduledStart);

                    // Skip expired locations
                    const expiresAt = new Date(location.expiresAt || now);
                    if (now > expiresAt) {
                        console.log(`Location ${location.name} has expired`);
                        continue;
                    }

                    const distance = calculateDistance(
                        lat, lng,
                        location.latitude, location.longitude
                    );

                    // Calculate the radius with a progressive scale for mobile devices
                    let adjustedRadius = location.radius;

                    if (isMobile) {
                        if (location.radius < 50) {
                            adjustedRadius = location.radius * 3;
                        } else if (location.radius < 100) {
                            adjustedRadius = location.radius * 2.5;
                        } else if (location.radius < 200) {
                            adjustedRadius = location.radius * 2;
                        } else {
                            adjustedRadius = location.radius * 1.5;
                        }
                    }

                    // Check if within radius (only after scheduled start)
                    let isNearby = !isBeforeStart && distance <= adjustedRadius;
                    let confidence = 'low';

                    if (isNearby) {
                        const confidenceThreshold1 = isMobile ? 0.6 : 0.5;
                        const confidenceThreshold2 = isMobile ? 0.9 : 0.8;

                        if (distance <= adjustedRadius * confidenceThreshold1) {
                            confidence = 'high';
                        } else if (distance <= adjustedRadius * confidenceThreshold2) {
                            confidence = 'medium';
                        }

                        nearbyLocations.push({
                            ...location,
                            id,
                            distance,
                            confidence,
                            attendanceMethod: location.attendanceMethod || 'location'
                        });
                    }

                    // Add to all active locations - ensure each location is added only once
                    allActiveLocations.push({
                        ...location,
                        id,
                        distance,
                        isNearby,
                        confidence: isNearby ? confidence : 'remote',
                        attendanceMethod: location.attendanceMethod || 'location'
                    });
                }

                // Sort locations by distance (closest first)
                nearbyLocations.sort((a, b) => a.distance - b.distance);

                // Always display all active classes for separate attendance
                displayAllActiveClasses(allActiveLocations, nearbyLocations);

                // Update UI based on nearby locations
                if (nearbyLocations.length > 0) {
                    locationBadge.className = 'badge badge-success';
                    locationBadge.textContent = `${nearbyLocations.length} Class${nearbyLocations.length > 1 ? 'es' : ''} Nearby`;
                    methodBadge.textContent = 'Select Class Below';
                    methodBadge.className = 'badge badge-info';
                } else {
                    locationBadge.className = 'badge badge-warning';
                    locationBadge.textContent = 'No Classes Nearby';
                    methodBadge.textContent = 'Must be at class location';
                    methodBadge.className = 'badge badge-warning';
                }

                // Hide main capture button as we'll use individual class buttons
                captureBtn.style.display = 'none';
                scannerContainer.classList.add('hidden');
                stopCamera();
            }
        })
        .catch((error) => {
            console.error("Error checking locations:", error);
            locationBadge.className = 'badge badge-danger';
            locationBadge.textContent = 'Location: Error';
            methodBadge.textContent = 'Method: Error';
            methodBadge.className = 'badge badge-danger';
        });
}

// Unsubscribe function for attendance listener
let unsubscribeAttendance = null;

// Load user's attended classes from Firebase with REAL-TIME LISTENER
function loadUserAttendedClasses() {
    return new Promise((resolve) => {
        if (!currentUser || !auth.currentUser) {
            cleanupAttendanceListener();
            resolve();
            return;
        }

        // Clean up previous listener if any
        if (unsubscribeAttendance) {
            // Check if unsubscribeAttendance is a function (from onValue) or we need to use off()
            if (typeof unsubscribeAttendance === 'function') {
                unsubscribeAttendance();
            }
            unsubscribeAttendance = null;
        }

        const today = new Date().toISOString().split('T')[0];
        const userAttendanceRef = ref(database, `user_attendance/${currentUser.uid}/${today}`);

        try {
            // Try using onValue (Modular SDK)
            unsubscribeAttendance = onValue(userAttendanceRef, (snapshot) => {
                attendedClasses.clear();
                window.attendedClasses.clear();
                attendedClassesData.clear();

                if (snapshot.exists()) {
                    const attendanceData = snapshot.val();
                    console.log("Real-time Attendance Data Update:", attendanceData); // Debugging

                    Object.keys(attendanceData).forEach(classId => {
                        attendedClasses.add(classId);
                        window.attendedClasses.add(classId);

                        // Robust handling: Ensure we have an object
                        let userRecord = attendanceData[classId];
                        if (typeof userRecord !== 'object' || userRecord === null) {
                            userRecord = { status: 'present' };
                        }
                        attendedClassesData.set(classId, userRecord);
                    });
                }
                resolve();
            }, (error) => {
                console.error("Error listening to attended classes:", error);
                resolve();
            });
        } catch (e) {
            console.warn("onValue not available, falling back to get()", e);
            // Fallback to get() if onValue is not defined
            get(userAttendanceRef)
                .then((snapshot) => {
                    attendedClasses.clear();
                    window.attendedClasses.clear();
                    attendedClassesData.clear();

                    if (snapshot.exists()) {
                        const attendanceData = snapshot.val();
                        console.log("Fetched Attendance Data (Fallback):", attendanceData);
                        Object.keys(attendanceData).forEach(classId => {
                            attendedClasses.add(classId);
                            window.attendedClasses.add(classId);

                            // Robust handling: Ensure we have an object
                            let userRecord = attendanceData[classId];
                            if (typeof userRecord !== 'object' || userRecord === null) {
                                userRecord = { status: 'present' };
                            }
                            attendedClassesData.set(classId, userRecord);
                        });
                    }
                    resolve();
                })
                .catch((error) => {
                    console.error("Error loading attended classes:", error);
                    resolve();
                });
        }
    });
}

// Store class display status in database
function storeClassDisplayStatus(locationId, displayed = true) {
    if (!currentUser) return;

    const displayRef = ref(database, `user_class_display/${currentUser.uid}/${locationId}`);
    set(displayRef, {
        displayed: displayed,
        timestamp: Date.now()
    }).catch(error => {
        console.error("Error storing display status:", error);
    });
}

// Enhanced function to display all active classes with dynamic visibility management
function displayAllActiveClasses(allLocations, nearbyLocations) {
    // Filter locations by user's section
    const userSection = currentUser?.section;
    const matchesSection = (location) => {
        if (!userSection || !location.section) return true;
        const sections = Array.isArray(location.section) ? location.section : [location.section];
        return sections.includes('General') || sections.includes(userSection);
    };

    const filteredLocations = allLocations.filter(matchesSection);
    const filteredNearbyLocations = nearbyLocations.filter(matchesSection);

    // Create or get the classes container
    let classesContainer = document.getElementById('classes-container');
    if (!classesContainer) {
        classesContainer = createClassesContainer();
    }

    // Store current scroll position
    const scrollPosition = window.pageYOffset || document.documentElement.scrollTop;

    // Get existing class items to preserve state
    const existingItems = new Map();
    const existingClassItems = classesContainer.querySelectorAll('.class-item');
    existingClassItems.forEach(item => {
        const locationId = item.dataset.locationId;
        if (locationId) {
            existingItems.set(locationId, item);
        }
    });

    // Remove duplicates by location ID
    const uniqueLocations = filteredLocations.filter((location, index, self) =>
        index === self.findIndex(l => l.id === location.id)
    );

    console.log(`Managing ${uniqueLocations.length} classes with dynamic visibility`);

    if (uniqueLocations.length === 0) {
        if (!classesContainer.querySelector('.no-classes-message')) {
            const noClassesDiv = document.createElement('div');
            noClassesDiv.className = 'status-indicator info no-classes-message';
            noClassesDiv.innerHTML = '<i class="fas fa-info-circle"></i> No classes available.';
            classesContainer.appendChild(noClassesDiv);
        }
        return;
    } else {
        // Remove no classes message if it exists
        const noClassesMsg = classesContainer.querySelector('.no-classes-message');
        if (noClassesMsg) {
            noClassesMsg.remove();
        }
    }

    // Track which classes should be visible
    const visibleClassIds = new Set();

    uniqueLocations.forEach(location => {
        const isAttended = attendedClasses.has(location.id);
        const isNearby = filteredNearbyLocations.some(nearby => nearby.id === location.id);
        const nearbyLocation = filteredNearbyLocations.find(nearby => nearby.id === location.id);

        // Calculate expiration time
        const expiresAt = new Date(location.expiresAt);
        const now = new Date();
        const minutesRemaining = Math.floor((expiresAt - now) / 60000);

        const scheduleInfo = getScheduleInfo(location);
        const scheduledStart = scheduleInfo.start;
        const hasScheduledStart = scheduleInfo.hasValue;
        const isBeforeStart = hasScheduledStart && (!scheduledStart || now < scheduledStart);
        const minutesToStart = (hasScheduledStart && scheduledStart)
            ? Math.max(0, Math.ceil((scheduledStart - now) / 60000))
            : 0;
        const startTimeLabel = scheduledStart
            ? scheduledStart.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : (hasScheduledStart ? 'Scheduled time' : '');

        // Skip expired classes
        if (minutesRemaining <= 0) {
            return;
        }

        // Skip attended classes that are already hidden
        const existingItem = existingItems.get(location.id);
        if (isAttended && existingItem && existingItem.style.display === 'none') {
            return;
        }

        // Determine visibility: show if scheduled (before start) or nearby (when active)
        const shouldShow = (isBeforeStart || isNearby) && !(isAttended && existingItem && existingItem.style.display === 'none');

        if (shouldShow) {
            visibleClassIds.add(location.id);

            let classItem = existingItems.get(location.id);

            if (classItem) {
                // Update existing class item
                updateExistingClassItem(classItem, location, isAttended, isNearby, nearbyLocation, minutesRemaining, isBeforeStart, minutesToStart, startTimeLabel);
            } else {
                // Create new class item
                classItem = createNewClassItem(location, isAttended, isNearby, nearbyLocation, minutesRemaining, isBeforeStart, minutesToStart, startTimeLabel);
                classItem.dataset.locationId = location.id;

                // Insert in the right position (after title)
                const title = classesContainer.querySelector('.classes-title');
                if (title && title.nextSibling) {
                    classesContainer.insertBefore(classItem, title.nextSibling);
                } else {
                    classesContainer.appendChild(classItem);
                }
            }

            // Ensure item is visible and reset any animation styles
            classItem.style.display = 'block';
            classItem.style.opacity = '1';
            classItem.style.transform = 'translateY(0)';
            classItem.style.transition = 'none';
            classItem.classList.remove('hidden');
        }
    });

    // Hide classes that are no longer nearby (but preserve hidden attended classes)
    existingItems.forEach((item, locationId) => {
        if (!visibleClassIds.has(locationId) && item.style.display !== 'none') {
            // Immediately hide the item without animation
            item.style.display = 'none';
        }
    });

    // Restore scroll position after a brief delay
    setTimeout(() => {
        window.scrollTo(0, scrollPosition);
    }, 50);
}

// Create classes container with styles
function createClassesContainer() {
    const classesContainer = document.createElement('div');
    classesContainer.id = 'classes-container';
    classesContainer.className = 'classes-container';

    const locationInfo = document.getElementById('location-info');
    if (locationInfo && locationInfo.parentNode) {
        locationInfo.parentNode.insertBefore(classesContainer, locationInfo.nextSibling);
    } else {
        captureBtn.parentNode.insertBefore(classesContainer, captureBtn);
    }

    // Add CSS for classes container
    if (!document.getElementById('classes-container-styles')) {
        const style = document.createElement('style');
        style.id = 'classes-container-styles';
        style.textContent = `
                    .classes-container {
                        margin: 20px 0;
                        padding: 15px;
                        background-color: white;
                        border-radius: var(--border-radius);
                        box-shadow: var(--shadow-md);
                    }
                    .classes-title {
                        margin-bottom: 15px;
                        font-weight: 600;
                        color: var(--gray-700);
                        font-size: 1.1rem;
                        border-bottom: 2px solid var(--primary-light);
                        padding-bottom: 8px;
                    }
                    .class-item {
                        border: 2px solid var(--gray-300);
                        border-radius: var(--border-radius);
                        padding: 15px;
                        margin-bottom: 15px;
                        background-color: var(--gray-100);
                        transition: all 0.3s ease;
                        position: relative;
                        opacity: 1;
                        transform: translateY(0);
                    }
                    .class-item.nearby {
                        border-color: var(--success-color);
                        background-color: rgba(46, 204, 113, 0.05);
                        animation: slideIn 0.3s ease;
                    }
                    .class-item.attended {
                        border-color: var(--primary-color);
                        background-color: rgba(102, 126, 234, 0.05);
                    }
                    .class-item.scheduled {
                        border-color: #f59e0b;
                        background-color: rgba(245, 158, 11, 0.08);
                    }
                    @keyframes slideIn {
                        from {
                            opacity: 0;
                            transform: translateY(10px);
                        }
                        to {
                            opacity: 1;
                            transform: translateY(0);
                        }
                    }
                    .class-name {
                        font-weight: bold;
                        font-size: 1.1rem;
                        margin-bottom: 8px;
                        color: var(--gray-800);
                    }
                    .class-details {
                        color: var(--gray-600);
                        font-size: 0.9rem;
                        margin-bottom: 12px;
                    }
                    .class-status {
                        position: absolute;
                        top: 15px;
                        right: 15px;
                        font-size: 0.8rem;
                        padding: 4px 8px;
                        border-radius: 12px;
                        font-weight: 500;
                    }
                    .status-nearby {
                        background-color: var(--success-color);
                        color: white;
                    }
                    .status-attended {
                        background-color: var(--primary-color);
                        color: white;
                    }
                    .status-scheduled {
                        background-color: #f59e0b;
                        color: white;
                    }
                    .status-remote {
                        background-color: var(--gray-500);
                        color: white;
                    }
                    .attendance-btn {
                        width: 100%;
                        padding: 10px;
                        margin-top: 8px;
                        font-weight: 600;
                        border-radius: var(--border-radius);
                        border: none;
                        cursor: pointer;
                        transition: all 0.2s ease;
                    }
                    .attendance-btn.nearby {
                        background-color: var(--success-color);
                        color: white;
                    }
                    .attendance-btn.nearby:hover {
                        background-color: #27ae60;
                        transform: translateY(-1px);
                    }
                    .attendance-btn:disabled {
                        background-color: var(--gray-400);
                        cursor: not-allowed;
                        transform: none;
                    }
                    .qr-scanner-mini {
                        margin-top: 10px;
                        padding: 10px;
                        background-color: rgba(0, 0, 0, 0.05);
                        border-radius: var(--border-radius);
                        text-align: center;
                        font-size: 0.9rem;
                        color: var(--gray-600);
                    }
                    .code-entry-mini {
                        margin-top: 10px;
                        padding: 10px;
                        background-color: rgba(0, 0, 0, 0.05);
                        border-radius: var(--border-radius);
                        text-align: center;
                        font-size: 0.9rem;
                        color: var(--gray-600);
                    }
                    .present-label {
                        background-color: var(--primary-color);
                        color: white;
                        padding: 8px 16px;
                        border-radius: 5px;
                        font-weight: bold;
                        text-align: center;
                    }
                `;
        document.head.appendChild(style);
    }

    // Add title
    const titleDiv = document.createElement('div');
    titleDiv.className = 'classes-title';
    titleDiv.innerHTML = '<i class="fas fa-chalkboard-teacher"></i> Available Classes for Attendance';
    classesContainer.appendChild(titleDiv);

    return classesContainer;
}

// Update existing class item
function updateExistingClassItem(classItem, location, isAttended, isNearby, nearbyLocation, minutesRemaining, isBeforeStart, minutesToStart, startTimeLabel) {
    // Update class type
    classItem.className = `class-item ${isAttended ? 'attended' : (isBeforeStart ? 'scheduled' : (isNearby ? 'nearby' : 'remote'))}`;

    // Update status
    const statusSpan = classItem.querySelector('.class-status');
    if (statusSpan) {
        if (isAttended) {
            statusSpan.className = 'class-status status-attended';
            statusSpan.textContent = 'Present';
        } else if (isBeforeStart) {
            statusSpan.className = 'class-status status-scheduled';
            statusSpan.textContent = 'Scheduled';
        } else if (isNearby) {
            statusSpan.className = 'class-status status-nearby';
            statusSpan.textContent = `Nearby (${Math.round(nearbyLocation.distance)}m)`;
        } else {
            statusSpan.className = 'class-status status-remote';
            statusSpan.textContent = 'Not in range';
        }
    }

    // Update time remaining
    const timeDiv = classItem.querySelector('.time-remaining');
    if (timeDiv) {
        if (isBeforeStart) {
            const startText = minutesToStart > 0
                ? `Starts in: ${minutesToStart} minutes`
                : `Starts at: ${startTimeLabel}`;
            timeDiv.innerHTML = `<i class="fas fa-clock"></i> ${startText}`;
        } else {
            timeDiv.innerHTML = `<i class="fas fa-clock"></i> Expires in: ${minutesRemaining} minutes`;
        }
    }

    // Update distance if nearby
    const distanceDiv = classItem.querySelector('.distance-info');
    if (!isBeforeStart && isNearby && nearbyLocation && !isAttended) {
        if (distanceDiv) {
            distanceDiv.innerHTML = `<i class="fas fa-route"></i> Distance: ${Math.round(nearbyLocation.distance)} meters`;
        } else {
            const classDetails = classItem.querySelector('.class-details');
            if (classDetails) {
                const newDistanceDiv = document.createElement('div');
                newDistanceDiv.className = 'distance-info';
                newDistanceDiv.innerHTML = `<i class="fas fa-route"></i> Distance: ${Math.round(nearbyLocation.distance)} meters`;
                classDetails.appendChild(newDistanceDiv);
            }
        }
    } else if (distanceDiv) {
        distanceDiv.remove();
    }

    // Update button
    const buttonContainer = classItem.querySelector('.button-container');
    if (buttonContainer) {
        if (isAttended) {
            buttonContainer.innerHTML = '<div class="present-label">Present</div>';
        } else if (isBeforeStart) {
            buttonContainer.innerHTML = '';
        } else if (isNearby) {
            buttonContainer.innerHTML = `
                        <button class="attendance-btn nearby" 
                                data-location-id="${location.id}" 
                                data-is-nearby="true"
                                data-requires-qr="${location.attendanceMethod === 'qr'}">
                            <i class="fas fa-map-marker-alt"></i> Mark Attendance
                        </button>
                    `;

            const btn = buttonContainer.querySelector('.attendance-btn');
            if (btn) {
                btn.addEventListener('click', () => {
                    handleClassAttendance(location, true);
                });
            }
        } else {
            buttonContainer.innerHTML = '';
        }
    }

    // Update method notices
    const existingQrNotice = classItem.querySelector('.qr-scanner-mini');
    if (existingQrNotice) existingQrNotice.remove();
    const existingCodeNotice = classItem.querySelector('.code-entry-mini');
    if (existingCodeNotice) existingCodeNotice.remove();

    if (!isBeforeStart && !isAttended && isNearby) {
        if (location.attendanceMethod === 'qr') {
            const notice = document.createElement('div');
            notice.className = 'qr-scanner-mini';
            notice.innerHTML = '<i class="fas fa-qrcode"></i> QR scanning will be required';
            classItem.appendChild(notice);
        } else if (location.attendanceMethod === 'code') {
            const notice = document.createElement('div');
            notice.className = 'code-entry-mini';
            notice.innerHTML = '<i class="fas fa-key"></i> Code entry will be required';
            classItem.appendChild(notice);
        } else if (location.attendanceMethod === 'face') {
            const notice = document.createElement('div');
            notice.className = 'qr-scanner-mini';
            notice.innerHTML = '<i class="fas fa-user-check"></i> Face verification will be required';
            classItem.appendChild(notice);
        }
    }
}

// Create new class item
function createNewClassItem(location, isAttended, isNearby, nearbyLocation, minutesRemaining, isBeforeStart, minutesToStart, startTimeLabel) {
    // Initial element create
    const classItem = document.createElement('div');

    // Base modifier
    let classModifiers = isAttended ? 'attended' : (isBeforeStart ? 'scheduled' : (isNearby ? 'nearby' : 'remote'));
    let statusText, statusClass, buttonContent;

    if (isAttended) {
        const record = attendedClassesData.get(location.id);
        // Ensure 'present' is default if status is missing
        const status = (record && record.status) ? record.status : 'present';

        // Debug log
        console.log(`Creating item for ${location.name}. IsAttended: ${isAttended}. Status: ${status}`);

        statusText = status.charAt(0).toUpperCase() + status.slice(1);

        // Set specific class modifiers and content based on status
        if (status === 'absent') {
            classModifiers = 'attended attended-absent';
            statusClass = 'status-absent';
            buttonContent = '<div class="present-label" style="background-color: var(--danger-color); color: white;">Absent</div>';
        } else if (status === 'late') {
            classModifiers = 'attended attended-late';
            statusClass = 'status-warning';
            buttonContent = '<div class="present-label" style="background-color: var(--warning-color); color: white;">Late</div>';
        } else {
            // Default present
            classModifiers = 'attended';
            statusClass = 'status-attended';
            buttonContent = '<div class="present-label">Present</div>';
        }
    } else if (isBeforeStart) {
        statusText = 'Scheduled';
        statusClass = 'status-scheduled';
        buttonContent = '';
    } else if (isNearby) {
        statusText = `Nearby (${Math.round(nearbyLocation.distance)}m)`;
        statusClass = 'status-nearby';
        buttonContent = `
                    <button class="attendance-btn nearby" 
                            data-location-id="${location.id}" 
                            data-is-nearby="true"
                            data-requires-qr="${location.attendanceMethod === 'qr'}">
                        <i class="fas fa-map-marker-alt"></i> Mark Attendance
                    </button>
                `;
    } else {
        // Not nearby case
        statusText = 'Not in range';
        statusClass = 'status-remote';
        buttonContent = '';
    }

    // Apply proper class name with modifiers
    classItem.className = `class-item ${classModifiers}`;

    classItem.innerHTML = `
                <div class="class-name">${location.name}</div>
                <div class="class-details">
                    <div class="time-remaining"><i class="fas fa-clock"></i> ${isBeforeStart ? (minutesToStart > 0 ? `Starts in: ${minutesToStart} minutes` : `Starts at: ${startTimeLabel}`) : `Expires in: ${minutesRemaining} minutes`}</div>
                    <div><i class="fas fa-map-marker-alt"></i> Method: ${location.attendanceMethod === 'qr' ? 'QR Code + Location' : (location.attendanceMethod === 'code' ? 'Location + Code' : (location.attendanceMethod === 'face' ? 'Face Recognition + Location' : 'Location Only'))}</div>
                    ${(!isBeforeStart && isNearby && !isAttended) ? `<div class="distance-info"><i class="fas fa-route"></i> Distance: ${Math.round(nearbyLocation.distance)} meters</div>` : ''}
                </div>
                <span class="class-status ${statusClass}">${statusText}</span>
                <div class="button-container">
                    ${buttonContent}
                </div>
                ${!isBeforeStart && location.attendanceMethod === 'qr' && isNearby && !isAttended ?
            '<div class="qr-scanner-mini"><i class="fas fa-qrcode"></i> QR scanning will be required</div>' : ''}
                ${!isBeforeStart && location.attendanceMethod === 'code' && isNearby && !isAttended ?
            '<div class="code-entry-mini"><i class="fas fa-key"></i> Code entry will be required</div>' : ''}
                ${!isBeforeStart && location.attendanceMethod === 'face' && isNearby && !isAttended ?
            '<div class="qr-scanner-mini"><i class="fas fa-user-check"></i> Face verification will be required</div>' : ''}
            `;

    // Add click event for attendance button
    if (!isAttended && isNearby) {
        const attendanceBtn = classItem.querySelector('.attendance-btn');
        if (attendanceBtn) {
            attendanceBtn.addEventListener('click', () => {
                handleClassAttendance(location, true);
            });
        }
    }

    return classItem;
}

// Function to handle attendance for a specific class
function handleClassAttendance(location, isNearby) {
    console.log(`Attempting to mark attendance for: ${location.name}`);

    const scheduleInfo = getScheduleInfo(location);
    if (scheduleInfo.hasValue) {
        const now = new Date();
        if (!scheduleInfo.start || now < scheduleInfo.start) {
            const startLabel = scheduleInfo.start
                ? scheduleInfo.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : 'the scheduled start time';
            const message = scheduleInfo.start
                ? `Class starts at ${startLabel}. Attendance will open at start time.`
                : 'Class is scheduled. Attendance will open at the start time.';
            showScanResult(message, 'warning');
            return;
        }
    }

    // Only allow attendance if user is nearby
    if (!isNearby) {
        showScanResult('You must be at the class location to mark attendance.', 'error');
        return;
    }

    // Handle different attendance methods
    if (location.attendanceMethod === 'qr') {
        // If QR is required and student is nearby, show QR scanner
        showQRScannerForClass(location);
    } else if (location.attendanceMethod === 'code') {
        // Location + Code method
        markAttendanceForClass(location.id, isNearby);
    } else if (location.attendanceMethod === 'face') {
        // If Face Recognition is required, show face scanner
        showFaceScannerForClass(location);
    } else {
        // Direct attendance marking for location-only method
        markAttendanceForClass(location.id, isNearby);
    }
}

// Function to show QR scanner for a specific class
function showQRScannerForClass(location) {
    // Create modal for QR scanning
    const modal = document.createElement('div');
    modal.className = 'modal-overlay visible';
    modal.id = 'qr-scanner-modal';
    modal.style.background = 'rgba(0,0,0,0.95)';
    modal.style.backdropFilter = 'blur(5px)';
    modal.style.padding = '0';
    modal.style.display = 'block'; // Override flex centering for custom layout

    modal.innerHTML = `
                <div class="scanner-container" style="position: relative; width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden;">
                    
                    <!-- Floating Header -->
                    <div style="position: absolute; top: 0; left: 0; right: 0; text-align: center; z-index: 10; padding: 40px 20px 20px; background: linear-gradient(to bottom, rgba(0,0,0,0.8), transparent);">
                        <h3 style="color: white; margin: 0; font-size: 1.3rem; font-weight: 600; text-shadow: 0 2px 4px rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; gap: 10px;">
                             <i class="fas fa-qrcode" style="color: var(--primary-color);"></i>
                             Scan QR for ${location.name}
                        </h3>
                        <p style="color: rgba(255,255,255,0.7); font-size: 0.9rem; margin-top: 5px; margin-bottom: 0;">Align the classroom QR code within the frame</p>
                    </div>

                    <!-- Flashlight Button (Initially Hidden) -->
                    <button id="torch-btn" onclick="toggleTorch()" style="display: none; position: absolute; top: 20px; left: 20px; background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.1); color: white; width: 44px; height: 44px; border-radius: 50%; align-items: center; justify-content: center; font-size: 1.2rem; cursor: pointer; z-index: 20; backdrop-filter: blur(5px); transition: all 0.2s;">
                        <i class="fas fa-bolt"></i>
                    </button>

                    <!-- Close Button -->
                    <button onclick="closeQRModal()" style="position: absolute; top: 20px; right: 20px; background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.1); color: white; width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.2rem; cursor: pointer; z-index: 20; backdrop-filter: blur(5px); transition: all 0.2s;">
                        <i class="fas fa-times"></i>
                    </button>

                    <!-- Camera Viewport logic: Use consistent responsive square -->
                    <div style="position: relative; width: 85vw; max-width: 400px; aspect-ratio: 1; border-radius: 24px; overflow: hidden; box-shadow: 0 0 0 100vmax rgba(0,0,0,0.6); z-index: 5;">
                         <video id="qr-video" autoplay playsinline style="width: 100%; height: 100%; object-fit: cover;"></video>
                         <canvas id="qr-canvas" style="display: none;"></canvas>
                         
                         <!-- Scanning Frame & Corner Accents -->
                         <div class="scan-frame" style="position: absolute; top: 20px; left: 20px; right: 20px; bottom: 20px; border: 1px solid rgba(255,255,255,0.2); border-radius: 12px; pointer-events: none;">
                            <!-- Animated Line -->
                            <div style="position: absolute; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, transparent, var(--success-color), transparent); box-shadow: 0 0 10px var(--success-color); animation: scan-move 2.5s cubic-bezier(0.4, 0, 0.2, 1) infinite;"></div>
                            
                            <!-- Glowing Corners -->
                            <div style="position: absolute; top: -2px; left: -2px; width: 30px; height: 30px; border-top: 4px solid var(--success-color); border-left: 4px solid var(--success-color); border-radius: 12px 0 0 0;"></div>
                            <div style="position: absolute; top: -2px; right: -2px; width: 30px; height: 30px; border-top: 4px solid var(--success-color); border-right: 4px solid var(--success-color); border-radius: 0 12px 0 0;"></div>
                            <div style="position: absolute; bottom: -2px; left: -2px; width: 30px; height: 30px; border-bottom: 4px solid var(--success-color); border-left: 4px solid var(--success-color); border-radius: 0 0 0 12px;"></div>
                            <div style="position: absolute; bottom: -2px; right: -2px; width: 30px; height: 30px; border-bottom: 4px solid var(--success-color); border-right: 4px solid var(--success-color); border-radius: 0 0 12px 0;"></div>
                         </div>
                    </div>

                    <div id="qr-zoom-controls" class="scanner-zoom-controls scanner-zoom-inline hidden"
                        aria-label="Camera zoom controls">
                        <button type="button" class="scanner-zoom-btn" id="qr-zoom-out" aria-label="Zoom out">
                            <i class="fas fa-minus"></i>
                        </button>
                        <input id="qr-zoom-range" class="scanner-zoom-range" type="range" min="1" max="1" step="0.1"
                            value="1" aria-label="Zoom level">
                        <button type="button" class="scanner-zoom-btn" id="qr-zoom-in" aria-label="Zoom in">
                            <i class="fas fa-plus"></i>
                        </button>
                        <span id="qr-zoom-value" class="scanner-zoom-value">1x</span>
                    </div>

                    <!-- Status Pill (Floating Below) -->
                    <div id="qr-status" style="margin-top: 40px; background: rgba(30, 41, 59, 0.9); backdrop-filter: blur(10px); color: white; border: 1px solid rgba(255,255,255,0.1); border-radius: 100px; padding: 12px 30px; display: inline-flex; align-items: center; gap: 12px; font-weight: 500; font-size: 0.95rem; box-shadow: 0 10px 25px rgba(0,0,0,0.3); z-index: 10; transition: all 0.3s ease;">
                        <i class="fas fa-circle-notch fa-spin" style="color: var(--primary-light);"></i> <span>Searching for code...</span>
                    </div>

                    <style>
                        @keyframes scan-move {
                            0% { top: 5%; opacity: 0; }
                            10% { opacity: 1; }
                            90% { opacity: 1; }
                            100% { top: 95%; opacity: 0; }
                        }
                        
                        /* Override generic modal styles for this instance */
                        #qr-scanner-modal .modal-content {
                            display: none !important; /* Ensure old content style doesn't interfere */
                        }
                    </style>
                </div>
            `;

    document.body.appendChild(modal);

    // Start QR scanning for this specific location
    startQRScanningForClass(location);
}

let currentQRStreamReference = null;

// Toggle Torch Function
window.toggleTorch = function () {
    if (currentQRStreamReference) {
        const track = currentQRStreamReference.getVideoTracks()[0];
        const capabilities = track.getCapabilities();
        if (capabilities.torch) {
            const currentSettings = track.getSettings();
            const newStatus = !currentSettings.torch;
            track.applyConstraints({
                advanced: [{ torch: newStatus }]
            }).then(() => {
                const btn = document.getElementById('torch-btn');
                if (btn) {
                    if (newStatus) {
                        btn.style.background = 'rgba(255, 255, 255, 0.9)';
                        btn.style.color = '#000';
                        btn.style.boxShadow = '0 0 15px rgba(255,255,255,0.5)';
                    } else {
                        btn.style.background = 'rgba(255, 255, 255, 0.15)';
                        btn.style.color = 'white';
                        btn.style.boxShadow = 'none';
                    }
                }
            }).catch(e => console.log(e));
        }
    }
};

// Function to start QR scanning for a specific class
async function startQRScanningForClass(location) {
    const video = document.getElementById('qr-video');
    const canvas = document.getElementById('qr-canvas');
    const statusDiv = document.getElementById('qr-status');
    const torchBtn = document.getElementById('torch-btn');

    try {
        await ensureJsQrLoaded();
    } catch (error) {
        console.error('Failed to load QR scanner:', error);
        if (statusDiv) {
            statusDiv.className = 'status-indicator error';
            statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> QR scanner failed to load';
        }
        return;
    }

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "environment",
                width: { ideal: CAMERA_IDEAL_WIDTH },
                height: { ideal: CAMERA_IDEAL_HEIGHT }
            }
        })
            .then((stream) => {
                video.srcObject = stream;
                currentQRStreamReference = stream;

                // Check for torch capability
                const track = stream.getVideoTracks()[0];
                let capabilities = null;
                if (track && typeof track.getCapabilities === 'function') {
                    try {
                        capabilities = track.getCapabilities();
                    } catch (error) {
                        capabilities = null;
                    }
                }
                if (capabilities && capabilities.torch && torchBtn) {
                    torchBtn.style.display = 'flex';
                }

                qrZoomController = createZoomController({
                    container: document.getElementById('qr-zoom-controls'),
                    range: document.getElementById('qr-zoom-range'),
                    zoomIn: document.getElementById('qr-zoom-in'),
                    zoomOut: document.getElementById('qr-zoom-out'),
                    value: document.getElementById('qr-zoom-value')
                }, {
                    enableDigitalZoom: true,
                    digitalMax: 3,
                    digitalStep: 0.1,
                    getDigitalMax: estimateDigitalMaxForStream,
                    onZoomChange: (value, mode) => {
                        qrZoomInfo = { value, mode };
                        applyDigitalZoomToVideo(video, qrZoomInfo);
                    }
                });

                if (qrZoomController) {
                    qrZoomController.attach(stream);
                }

                let qrScanning = false;

                // Start scanning
                const scanInterval = setInterval(() => {
                    if (!video.videoWidth || qrScanning) {
                        return;
                    }
                    qrScanning = true;

                    const frameDrawn = drawVideoToScanCanvas(video, canvas, qrZoomInfo);
                    const ctx = getCanvasContext(canvas);
                    if (!frameDrawn || !ctx) {
                        qrScanning = false;
                        return;
                    }

                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const code = jsQR(imageData.data, imageData.width, imageData.height);

                    if (code) {
                        const qrData = parseAttendanceQrPayload(code.data);

                        if (qrData && qrData.locationId === location.id) {
                            // Valid QR code for this location
                            clearInterval(scanInterval);

                            // Trigger verification feedback
                            if (navigator.vibrate) navigator.vibrate([100, 50, 100]); // SUCCESS VIBRATION

                            // Play beep
                            try {
                                const AudioContext = window.AudioContext || window.webkitAudioContext;
                                if (AudioContext) {
                                    const audioCtx = new AudioContext();
                                    const oscillator = audioCtx.createOscillator();
                                    const gainNode = audioCtx.createGain();
                                    oscillator.connect(gainNode);
                                    gainNode.connect(audioCtx.destination);
                                    oscillator.type = 'sine';
                                    oscillator.frequency.value = 1000;
                                    gainNode.gain.value = 0.1;
                                    oscillator.start();
                                    setTimeout(() => { oscillator.stop(); audioCtx.close(); }, 200);
                                }
                            } catch (e) {
                                console.log("Audio not supported");
                            }

                            // Stop camera
                            const tracks = stream.getTracks();
                            tracks.forEach(track => track.stop());
                            currentQRStreamReference = null;

                            statusDiv.style.background = 'rgba(46, 204, 113, 0.9)'; // Success Green
                            statusDiv.style.borderColor = 'rgba(46, 204, 113, 1)';
                            statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> VERIFIED! Redirecting...';

                            setTimeout(() => {
                                closeQRModal();
                                markAttendanceForClass(location.id, true);
                            }, 1500);
                        } else {
                            if (statusDiv.innerHTML.includes('Searching')) {
                                statusDiv.style.background = 'rgba(231, 76, 60, 0.9)'; // Error Red
                                statusDiv.innerHTML = '<i class="fas fa-times-circle"></i> Invalid QR Code';
                                if (navigator.vibrate) navigator.vibrate(200); // ERROR VIBRATION

                                setTimeout(() => {
                                    statusDiv.style.background = 'rgba(30, 41, 59, 0.9)';
                                    statusDiv.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> <span>Searching for code...</span>';
                                }, 1500);
                            }
                        }
                    }

                    qrScanning = false;
                }, QR_MODAL_SCAN_INTERVAL_MS);

                // Store interval for clean up
                window.currentQRScanInterval = scanInterval;
                window.currentQRStream = stream;
            })
            .catch((error) => {
                console.error("Camera error:", error);
                statusDiv.className = 'status-indicator error';
                statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Camera access denied';
            });
    }
}

// Function to close QR modal
window.closeQRModal = function () {
    const modal = document.getElementById('qr-scanner-modal');
    if (modal) {
        // Stop camera and scanning
        if (window.currentQRScanInterval) {
            clearInterval(window.currentQRScanInterval);
        }
        if (window.currentQRStream) {
            const tracks = window.currentQRStream.getTracks();
            tracks.forEach(track => track.stop());
        }

        if (qrZoomController) {
            qrZoomController.reset();
            qrZoomController = null;
        }

        modal.remove();
    }
};

// Face Recognition Models Loading
let faceModelsLoaded = false;
let loadingFaceModels = false;

async function loadFaceModels() {
    if (faceModelsLoaded || loadingFaceModels) return faceModelsLoaded;

    loadingFaceModels = true;
    try {
        await ensureFaceApiLoaded();
        await faceapi.nets.tinyFaceDetector.loadFromUri('https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights');
        await faceapi.nets.faceLandmark68Net.loadFromUri('https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights');
        await faceapi.nets.faceRecognitionNet.loadFromUri('https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights');

        faceModelsLoaded = true;
        console.log('Face recognition models loaded successfully');
        return true;
    } catch (error) {
        console.error('Error loading face models:', error);
        loadingFaceModels = false;
        return false;
    }
}

// Function to show Face Scanner for a specific class
function showFaceScannerForClass(location) {
    // Create modal for face scanning
    const modal = document.createElement('div');
    modal.className = 'modal-overlay visible';
    modal.id = 'face-scanner-modal';

    modal.innerHTML = `
                <div class="modal-content" style="max-width: 500px; width: 95%; max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; padding: 0; border-radius: 16px;">
                    <div class="modal-header" style="padding: 15px; background: linear-gradient(135deg, var(--primary-color), var(--primary-light)); color: white; flex-shrink: 0; display: flex; justify-content: space-between; align-items: center;">
                        <h3 style="margin: 0; font-size: 1.1rem; display: flex; align-items: center; gap: 10px;"><i class="fas fa-user-check"></i> Face Verification</h3>
                        <button class="modal-close" onclick="closeFaceModal()" style="background: none; border: none; color: white; font-size: 1.5rem; cursor: pointer; line-height: 1; padding: 0;">&times;</button>
                    </div>
                    
                    <div class="modal-body" style="padding: 15px; display: flex; flex-direction: column; flex: 1; overflow: hidden; gap: 10px;">
                        <!-- Loading State -->
                        <div id="face-loading" style="text-align: center; flex: 1; display: flex; flex-direction: column; justify-content: center; min-height: 200px;">
                            <div class="loader-spinner" style="width: 40px; height: 40px; margin: 0 auto 15px;"></div>
                            <p style="color: var(--text-secondary);">Loading models...</p>
                        </div>

                        <!-- Camera View -->
                        <div id="face-camera-container" class="camera-container" style="display: none; position: relative; border-radius: 12px; overflow: hidden; flex: 1; background: #000; min-height: 0;">
                            <video id="face-video" autoplay playsinline muted style="width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1);"></video>
                            <canvas id="face-canvas" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; transform: scaleX(-1);"></canvas>
                        </div>
                        
                        <!-- Compact Status & Info -->
                        <div style="flex-shrink: 0;">
                             <div id="face-status" class="status-indicator info" style="margin: 0; padding: 12px; font-size: 0.9rem; margin-bottom: 5px; border-radius: 8px;">
                                <i class="fas fa-camera"></i> Initializing...
                            </div>
                            
                            <div id="face-quality" style="display: none;"></div>

                            <div id="face-user-info" style="display: none; font-size: 0.85rem; color: var(--gray-600); text-align: center; padding: 5px;">
                                Verifying as: <strong>${currentUser?.name || 'Unknown'}</strong> (${currentUser?.classRoll || 'N/A'})
                            </div>
                        </div>
                    </div>
                    
                    <div class="modal-footer" style="padding: 15px; background: var(--gray-50); display: flex; gap: 10px; justify-content: center; flex-shrink: 0;">
                        <button id="face-verify-btn" class="btn btn-success" onclick="verifyFaceForAttendance('${location.id}')" disabled style="flex: 1; padding: 12px; justify-content: center;">
                            <i class="fas fa-camera"></i> Capture & Verify
                        </button>
                    </div>
                </div>
            `;

    document.body.appendChild(modal);

    // Store location for verification
    window.currentFaceLocation = location;

    // Start face verification process
    startFaceVerification(location);
}

// Start face verification camera and detection
async function startFaceVerification(location) {
    const loadingDiv = document.getElementById('face-loading');
    const cameraContainer = document.getElementById('face-camera-container');
    const statusDiv = document.getElementById('face-status');
    const verifyBtn = document.getElementById('face-verify-btn');
    const userInfoDiv = document.getElementById('face-user-info');

    // Load face models first
    const modelsLoaded = await loadFaceModels();
    if (!modelsLoaded) {
        statusDiv.className = 'status-indicator error';
        statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Failed to load face recognition models. Please try again.';
        loadingDiv.style.display = 'none';
        return;
    }

    // Check if user has a face profile registered
    try {
        const userSnapshot = await get(ref(database, `users/${currentUser.uid}/faceDescriptor`));
        if (!userSnapshot.exists()) {
            // Generate access token for face registration
            const accessToken = generateAccessToken();

            // Store token in Firebase with user info
            await set(ref(database, `faceRegistrationTokens/${accessToken}`), {
                uid: currentUser.uid,
                email: currentUser.email,
                name: currentUser.name,
                classRoll: currentUser.classRoll || '',
                univRoll: currentUser.univRoll || '',
                createdAt: Date.now(),
                expiresAt: Date.now() + (10 * 60 * 1000) // 10 minute expiry
            });

            statusDiv.className = 'status-indicator warning';
            statusDiv.innerHTML = `
                        <i class="fas fa-exclamation-circle"></i> No face profile found! 
                        <br><br>
                        <button id="register-face-btn" class="btn btn-primary" style="background: var(--primary-color); color: white; padding: 10px 20px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">
                            <i class="fas fa-user-plus"></i> Register Your Face
                        </button>
                    `;

            // Add click handler for registration button
            setTimeout(() => {
                const registerBtn = document.getElementById('register-face-btn');
                if (registerBtn) {
                    registerBtn.addEventListener('click', () => {
                        window.location.href = `face-attendance.html?token=${accessToken}`;
                    });
                }
            }, 100);

            loadingDiv.style.display = 'none';
            return;
        }
    } catch (error) {
        console.error('Error checking face profile:', error);
        statusDiv.className = 'status-indicator error';
        statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error checking face profile. Please try again.';
        loadingDiv.style.display = 'none';
        return;
    }

    loadingDiv.style.display = 'none';
    cameraContainer.style.display = 'block';
    userInfoDiv.style.display = 'block';

    // Start camera with front-facing mode
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "user",
                width: { ideal: 640 },
                height: { ideal: 480 }
            }
        });

        const video = document.getElementById('face-video');
        video.srcObject = stream;

        window.currentFaceStream = stream;

        statusDiv.className = 'status-indicator info';
        statusDiv.innerHTML = '<i class="fas fa-camera"></i> Position your face in the camera and click "Capture & Verify Face"';
        verifyBtn.disabled = false;

        // Start face detection overlay
        startFaceDetectionOverlay();

    } catch (error) {
        console.error('Camera error:', error);
        statusDiv.className = 'status-indicator error';
        statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Camera access denied. Please allow camera access.';
    }
}

// Start face detection overlay for visual feedback
function startFaceDetectionOverlay() {
    const video = document.getElementById('face-video');
    const canvas = document.getElementById('face-canvas');
    const statusDiv = document.getElementById('face-status');
    const qualityDiv = document.getElementById('face-quality');

    if (!video || !canvas) return;

    const ctx = canvas.getContext('2d');

    window.faceDetectionInterval = setInterval(async () => {
        if (!video.videoWidth) return;

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;

        try {
            const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
                .withFaceLandmarks();

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            if (detections.length === 1) {
                const detection = detections[0];
                const box = detection.detection.box;

                // Draw face box
                ctx.strokeStyle = '#00d4aa';
                ctx.lineWidth = 3;
                ctx.strokeRect(box.x, box.y, box.width, box.height);

                // Calculate and show quality
                const quality = detection.detection.score;
                qualityDiv.style.display = 'block';

                if (quality > 0.9) {
                    qualityDiv.innerHTML = '<span style="color: #00d4aa; font-weight: bold;"><i class="fas fa-check-circle"></i> Face Quality: Excellent</span>';
                } else if (quality > 0.7) {
                    qualityDiv.innerHTML = '<span style="color: #feca57; font-weight: bold;"><i class="fas fa-check-circle"></i> Face Quality: Good</span>';
                } else {
                    qualityDiv.innerHTML = '<span style="color: #ff6b6b; font-weight: bold;"><i class="fas fa-exclamation-circle"></i> Face Quality: Poor - Move closer</span>';
                }

                statusDiv.className = 'status-indicator success';
                statusDiv.innerHTML = '<i class="fas fa-check"></i> Face detected! Click "Capture & Verify Face" to continue.';
            } else if (detections.length > 1) {
                statusDiv.className = 'status-indicator warning';
                statusDiv.innerHTML = '<i class="fas fa-users"></i> Multiple faces detected. Please ensure only one face is visible.';
                qualityDiv.style.display = 'none';
            } else {
                statusDiv.className = 'status-indicator info';
                statusDiv.innerHTML = '<i class="fas fa-camera"></i> No face detected. Position your face in the camera.';
                qualityDiv.style.display = 'none';
            }
        } catch (error) {
            console.error('Face detection error:', error);
        }
    }, FACE_DETECT_INTERVAL_MS);
}

// Verify face for attendance
window.verifyFaceForAttendance = async function (locationId) {
    const video = document.getElementById('face-video');
    const statusDiv = document.getElementById('face-status');
    const verifyBtn = document.getElementById('face-verify-btn');

    if (!video || !faceModelsLoaded) {
        statusDiv.className = 'status-indicator error';
        statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Face recognition not ready. Please wait...';
        return;
    }

    verifyBtn.disabled = true;
    verifyBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Verifying...';
    statusDiv.className = 'status-indicator info';
    statusDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Capturing and verifying face...';

    try {
        // Stop detection overlay
        if (window.faceDetectionInterval) {
            clearInterval(window.faceDetectionInterval);
        }

        // Detect face with descriptor
        const detections = await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
            .withFaceLandmarks()
            .withFaceDescriptors();

        if (detections.length === 0) {
            statusDiv.className = 'status-indicator error';
            statusDiv.innerHTML = '<i class="fas fa-times"></i> No face detected. Please try again.';
            verifyBtn.disabled = false;
            verifyBtn.innerHTML = '<i class="fas fa-camera"></i> Capture & Verify Face';
            startFaceDetectionOverlay();
            return;
        }

        if (detections.length > 1) {
            statusDiv.className = 'status-indicator warning';
            statusDiv.innerHTML = '<i class="fas fa-users"></i> Multiple faces detected. Please ensure only one face is visible.';
            verifyBtn.disabled = false;
            verifyBtn.innerHTML = '<i class="fas fa-camera"></i> Capture & Verify Face';
            startFaceDetectionOverlay();
            return;
        }

        const capturedDescriptor = detections[0].descriptor;

        // Get stored face descriptor from Firebase
        const userSnapshot = await get(ref(database, `users/${currentUser.uid}/faceDescriptor`));

        if (!userSnapshot.exists()) {
            statusDiv.className = 'status-indicator error';
            statusDiv.innerHTML = '<i class="fas fa-times"></i> No face profile registered. Please register your face first.';
            verifyBtn.disabled = false;
            verifyBtn.innerHTML = '<i class="fas fa-camera"></i> Capture & Verify Face';
            return;
        }

        const storedDescriptor = new Float32Array(userSnapshot.val());
        const distance = faceapi.euclideanDistance(storedDescriptor, capturedDescriptor);

        console.log('Face verification distance:', distance);

        // Threshold for face match (lower is better, typically 0.6 or less is considered a match)
        if (distance < 0.6) {
            const confidence = Math.round((1 - distance) * 100);
            statusDiv.className = 'status-indicator success';
            statusDiv.innerHTML = `<i class="fas fa-check-circle"></i> Face verified! Confidence: ${confidence}%. Marking attendance...`;

            // Close modal and mark attendance
            setTimeout(() => {
                closeFaceModal();
                markAttendanceForClass(locationId, true);
            }, 1500);

        } else {
            statusDiv.className = 'status-indicator error';
            statusDiv.innerHTML = '<i class="fas fa-times-circle"></i> Face verification failed! This does not match your registered face profile.';
            verifyBtn.disabled = false;
            verifyBtn.innerHTML = '<i class="fas fa-camera"></i> Try Again';
            startFaceDetectionOverlay();
        }

    } catch (error) {
        console.error('Face verification error:', error);
        statusDiv.className = 'status-indicator error';
        statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error during verification: ' + error.message;
        verifyBtn.disabled = false;
        verifyBtn.innerHTML = '<i class="fas fa-camera"></i> Try Again';
        startFaceDetectionOverlay();
    }
};

// Function to close Face modal
window.closeFaceModal = function () {
    const modal = document.getElementById('face-scanner-modal');
    if (modal) {
        // Stop face detection
        if (window.faceDetectionInterval) {
            clearInterval(window.faceDetectionInterval);
            window.faceDetectionInterval = null;
        }

        // Stop camera
        if (window.currentFaceStream) {
            const tracks = window.currentFaceStream.getTracks();
            tracks.forEach(track => track.stop());
            window.currentFaceStream = null;
        }

        // Clear location reference
        window.currentFaceLocation = null;

        modal.remove();
    }
};

// Function to generate a secure access token for face registration
function generateAccessToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 32; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return token + '_' + Date.now();
}

// Function to show blocked user popup
function showBlockedUserPopup() {
    // Check if popup already exists
    if (document.getElementById('blocked-user-modal')) {
        return;
    }

    const modal = document.createElement('div');
    modal.className = 'modal-overlay visible';
    modal.id = 'blocked-user-modal';

    modal.innerHTML = `
                <div class="modal-content">
                    <div class="modal-header">
                        <h3><i class="fas fa-ban"></i> Access Blocked</h3>
                    </div>
                    <div class="modal-body">
                        <div class="status-indicator error">
                            <i class="fas fa-exclamation-triangle"></i>
                            You are blocked from access, contact your teacher to unblock you.
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button onclick="closeBlockedUserPopup()" class="btn-primary">
                            <i class="fas fa-check"></i> OK
                        </button>
                    </div>
                </div>
            `;

    document.body.appendChild(modal);
}

// Function to close blocked user popup
window.closeBlockedUserPopup = function () {
    const modal = document.getElementById('blocked-user-modal');
    if (modal) {
        modal.remove();
    }
};

function normalizeAttendanceCode(value) {
    return String(value || '').toUpperCase().replace(/[\s-]/g, '');
}

function promptForAttendanceCode(locationData) {
    return new Promise((resolve) => {
        const expectedCode = normalizeAttendanceCode(locationData.attendanceCode);

        if (!expectedCode) {
            showScanResult("Attendance code is not set for this class.", 'error');
            resolve(false);
            return;
        }

        const modal = document.createElement('div');
        modal.className = 'modal-overlay visible';
        modal.id = 'attendance-code-modal';

        modal.innerHTML = `
                    <div class="modal-content" style="max-width: 420px;">
                        <div class="modal-header">
                            <h3><i class="fas fa-key"></i> Enter Attendance Code</h3>
                        </div>
                        <div class="modal-body">
                            <p style="margin-top: 0;">Enter the code for <strong>${locationData.name}</strong>.</p>
                            <input type="text" id="attendance-code-input" placeholder="e.g. 123456" style="width: 100%; padding: 12px; border: 1px solid var(--gray-300); border-radius: 8px; font-size: 1rem; text-align: center; letter-spacing: 4px;">
                            <div id="attendance-code-error" class="status-indicator error" style="display: none; margin-top: 12px;">
                                Invalid code. Please try again.
                            </div>
                        </div>
                        <div class="modal-footer" style="display: flex; gap: 10px; justify-content: flex-end;">
                            <button class="btn-secondary" id="cancel-attendance-code">Cancel</button>
                            <button class="btn-primary" id="submit-attendance-code">Verify</button>
                        </div>
                    </div>
                `;

        document.body.appendChild(modal);

        const input = modal.querySelector('#attendance-code-input');
        const errorEl = modal.querySelector('#attendance-code-error');
        const submitBtn = modal.querySelector('#submit-attendance-code');
        const cancelBtn = modal.querySelector('#cancel-attendance-code');

        const closeModal = (result) => {
            if (modal && modal.parentNode) {
                modal.remove();
            }
            resolve(result);
        };

        const showError = (message) => {
            if (errorEl) {
                errorEl.textContent = message;
                errorEl.style.display = 'flex';
            }
        };

        const handleSubmit = () => {
            const entered = normalizeAttendanceCode(input ? input.value : '');
            if (!entered) {
                showError('Please enter the attendance code.');
                return;
            }
            if (entered !== expectedCode) {
                showError('Invalid code. Please try again.');
                return;
            }
            closeModal(true);
        };

        if (submitBtn) {
            submitBtn.addEventListener('click', handleSubmit);
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => closeModal(false));
        }

        if (input) {
            input.addEventListener('keyup', (event) => {
                if (event.key === 'Enter') {
                    handleSubmit();
                } else if (event.key === 'Escape') {
                    closeModal(false);
                }
            });
            setTimeout(() => input.focus(), 50);
        }

        modal.addEventListener('click', (event) => {
            if (event.target === modal) {
                closeModal(false);
            }
        });
    });
}

// Function to mark attendance for a specific class
function markAttendanceForClass(locationId, isNearby, options = {}) {
    if (enforceAndroidAppOnly((msg) => showScanResult(msg, 'error'))) {
        return;
    }

    if (!currentUser) {
        showScanResult("User information not available. Please try logging in again.", 'error');
        return;
    }

    if (!isNearby) {
        showScanResult('You must be at the class location to mark attendance.', 'error');
        return;
    }

    primeAttendanceNotificationPermission();

    // Show loading state
    const button = document.querySelector(`[data-location-id="${locationId}"]`);
    const originalButtonHtml = button ? button.innerHTML : '';
    if (button) {
        button.disabled = true;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Marking...';
    }

    // Verify that the location exists and is active
    const locationRef = ref(database, `locations/${locationId}`);
    get(locationRef).then((snapshot) => {
        if (!snapshot.exists()) {
            showScanResult("This location no longer exists.", 'error');
            return;
        }

        const locationData = snapshot.val();
        const now = new Date();
        const expiresAt = new Date(locationData.expiresAt || now);

        // Check if class is still active / scheduled
        const scheduleInfo = getScheduleInfo(locationData);
        if (scheduleInfo.hasValue && (!scheduleInfo.start || scheduleInfo.start > now)) {
            showScanResult("This class has not started yet.", 'error');
            if (button) {
                button.disabled = false;
                button.innerHTML = originalButtonHtml || '<i class="fas fa-map-marker-alt"></i> Mark Attendance';
            }
            return;
        }

        if (now > expiresAt) {
            showScanResult("This class has already ended.", 'error');
            return;
        }

        if (locationData.attendanceMethod === 'code' && !options.codeVerified) {
            if (button) {
                button.disabled = false;
                button.innerHTML = originalButtonHtml || '<i class="fas fa-map-marker-alt"></i> Mark Attendance';
            }
            promptForAttendanceCode(locationData).then((verified) => {
                if (verified) {
                    markAttendanceForClass(locationId, isNearby, { codeVerified: true });
                }
            });
            return;
        }

        const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const timeStr = now.toISOString().split('T')[1].slice(0, 8); // HH:MM:SS

        // Create attendance record
        const attendanceData = {
            userId: currentUser.uid,
            userName: currentUser.name || 'Unknown User',
            userEmail: currentUser.email || 'No Email',
            classRoll: currentUser.classRoll ? String(currentUser.classRoll) : "",
            univRoll: currentUser.univRoll ? String(currentUser.univRoll) : "",
            section: currentUser.section || "",
            locationId: locationId,
            locationName: locationData.name || 'Unknown Location',
            date: dateStr,
            time: timeStr,
            timestamp: now.getTime(),
            latitude: currentPosition ? currentPosition.coords.latitude : null,
            longitude: currentPosition ? currentPosition.coords.longitude : null,
            status: 'present',
            attendanceType: isNearby ? 'nearby' : 'remote',
            verificationMethod: locationData.attendanceMethod || 'location'
        };

        // Check if already marked attendance for this specific class today
        const userAttendanceRef = ref(database, `user_attendance/${currentUser.uid}/${dateStr}/${locationId}`);
        get(userAttendanceRef)
            .then((snapshot) => {
                if (snapshot.exists()) {
                    showScanResult("You have already marked attendance for this class today.", 'warning');
                    return Promise.reject('already_marked');
                }

                // Save to user_attendance (for tracking attended classes)
                const userAttendancePromise = set(userAttendanceRef, attendanceData);

                // Save to attendance_by_location (for admin records)
                const attendanceByLocationRef = ref(database, `attendance_by_location/${locationId}/${dateStr}/${currentUser.uid}`);
                const locationAttendancePromise = set(attendanceByLocationRef, attendanceData);

                return Promise.all([userAttendancePromise, locationAttendancePromise]);
            })
            .then(() => {
                // Add to attended classes set
                attendedClasses.add(locationId);
                window.attendedClasses.add(locationId);

                // Show Present status for 2 seconds then hide
                if (button) {
                    const classItem = button.closest('.class-item');
                    if (classItem) {
                        // Update class item to attended state
                        classItem.className = 'class-item attended';

                        // Update status badge
                        const statusSpan = classItem.querySelector('.class-status');
                        if (statusSpan) {
                            statusSpan.className = 'class-status status-attended';
                            statusSpan.textContent = 'Present';
                        }

                        // Replace button container with Present label
                        const buttonContainer = classItem.querySelector('.button-container');
                        if (buttonContainer) {
                            buttonContainer.innerHTML = '<div class="present-label">Present</div>';
                        }

                        // After 2 seconds, hide the class item
                        setTimeout(() => {
                            classItem.style.display = 'none';
                        }, 2000);
                    }
                }

                // Create both device and user locks when attendance is marked
                if (!deviceId) {
                    deviceId = generateDeviceId();
                }
                if (!deviceFingerprint) {
                    deviceFingerprint = generateDeviceFingerprint();
                }

                const lockData = {
                    userId: currentUser.uid,
                    userEmail: currentUser.email,
                    attendanceTime: now.getTime(),
                    deviceInfo: navigator.userAgent,
                    locationName: locationData.name,
                    deviceId: deviceId,
                    deviceFingerprint: deviceFingerprint,
                    devicePlatform: isIOSDevice ? 'ios' : (isAndroidDevice ? 'android' : 'other')
                };

                const deviceLockPromise = set(ref(database, `deviceLocks/${deviceId}`), lockData);
                const fingerprintLockPromise = set(ref(database, `deviceFingerprintLocks/${deviceFingerprint}`), lockData);
                const userLockPromise = set(ref(database, `userLocks/${currentUser.uid}`), lockData);

                Promise.all([deviceLockPromise, fingerprintLockPromise, userLockPromise])
                    .then(() => {
                        console.log('Device and user locked for 30 minutes after attendance marking');

                        if (isIOSDevice) {
                            const expiresAt = now.getTime() + IOS_LOCAL_LOCK_WINDOW_MS;
                            setIosLocalLock({
                                userId: currentUser.uid,
                                deviceId: deviceId,
                                deviceFingerprint: deviceFingerprint,
                                acquiredAt: now.getTime(),
                                expiresAt: expiresAt
                            });
                        }

                        // Set up automatic cleanup after 30 minutes
                        setTimeout(() => {
                            console.log('Cleaning up expired locks');
                            remove(ref(database, `deviceLocks/${deviceId}`)).catch(error =>
                                console.error('Error removing expired device lock:', error)
                            );
                            remove(ref(database, `deviceFingerprintLocks/${deviceFingerprint}`)).catch(error =>
                                console.error('Error removing expired fingerprint lock:', error)
                            );
                            remove(ref(database, `userLocks/${currentUser.uid}`)).catch(error =>
                                console.error('Error removing expired user lock:', error)
                            );
                            if (isIOSDevice) {
                                clearIosLocalLock();
                            }
                        }, 30 * 60 * 1000); // 30 minutes
                    })
                    .catch((error) => {
                        console.error('Error creating locks:', error);
                    });

                showScanResult(`Attendance marked successfully for ${locationData.name}!`, 'success');
                notifyAttendanceMarked(locationData.name, now.getTime());
            })
            .catch((error) => {
                if (error === 'already_marked') {
                    // Reset button for already marked case
                    if (button) {
                        button.disabled = true;
                        button.innerHTML = '<i class="fas fa-check"></i> Already Marked';
                    }
                    return;
                }
                showScanResult(`Attendance marking failed: ${error.message}`, 'error');
                console.error("Error marking attendance:", error);

                // Reset button on error
                if (button) {
                    button.disabled = false;
                    button.innerHTML = `<i class="fas fa-map-marker-alt"></i> Mark Attendance`;
                }
            });
    }).catch((error) => {
        showScanResult(`Error verifying location: ${error.message}`, 'error');
        console.error("Error verifying location:", error);

        // Reset button on location verification error
        if (button) {
            button.disabled = false;
            button.innerHTML = '<i class="fas fa-map-marker-alt"></i> Mark Attendance';
        }
    });
}

// Old function to display multiple locations as blocks (kept for compatibility)
function displayLocationBlocks(locations) {
    // Create or get the location blocks container
    let locationBlocksDiv = document.getElementById('location-blocks');
    if (!locationBlocksDiv) {
        locationBlocksDiv = document.createElement('div');
        locationBlocksDiv.id = 'location-blocks';
        locationBlocksDiv.className = 'location-blocks-container';

        // Insert after the location-info section
        const locationInfo = document.getElementById('location-info');
        if (locationInfo && locationInfo.parentNode) {
            locationInfo.parentNode.insertBefore(locationBlocksDiv, locationInfo.nextSibling);
        } else {
            // Fallback - insert before capture button
            captureBtn.parentNode.insertBefore(locationBlocksDiv, captureBtn);
        }

        // Add CSS for location blocks
        const style = document.createElement('style');
        style.textContent = `
                    .location-blocks-container {
                        margin: 20px 0;
                        padding: 10px;
                    }
                    .location-block-title {
                        margin-bottom: 10px;
                        font-weight: 600;
                        color: var(--gray-700);
                    }
                    .location-block {
                        border: 2px solid var(--primary-light);
                        border-radius: var(--border-radius);
                        padding: 15px;
                        margin-bottom: 15px;
                        background-color: white;
                        cursor: pointer;
                        transition: all 0.2s ease;
                        position: relative;
                    }
                    .location-block:hover {
                        transform: translateY(-3px);
                        box-shadow: 0 5px 15px rgba(0,0,0,0.1);
                    }
                    .location-block.high-confidence {
                        border-color: var(--success-color);
                        background-color: rgba(46, 204, 113, 0.05);
                    }
                    .location-block.medium-confidence {
                        border-color: var(--warning-color);
                        background-color: rgba(243, 156, 18, 0.05);
                    }
                    .location-block.low-confidence {
                        border-color: var(--danger-color);
                        background-color: rgba(231, 76, 60, 0.05);
                    }
                    .location-name {
                        font-weight: bold;
                        font-size: 1.1rem;
                        margin-bottom: 5px;
                    }
                    .location-details {
                        color: var(--gray-600);
                        font-size: 0.9rem;
                    }
                    .confidence-badge {
                        position: absolute;
                        top: 15px;
                        right: 15px;
                        font-size: 0.8rem;
                        padding: 3px 8px;
                        border-radius: 12px;
                    }
                    .back-button {
                        background-color: var(--gray-500);
                        color: white;
                        border: none;
                        padding: 8px 15px;
                        border-radius: var(--border-radius);
                        margin-bottom: 15px;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        font-size: 0.9rem;
                    }
                    .back-button:hover {
                        background-color: var(--gray-600);
                    }
                    .back-button .icon {
                        margin-right: 5px;
                    }
                `;
        document.head.appendChild(style);
    }

    // Clear and show the container
    locationBlocksDiv.innerHTML = '';
    locationBlocksDiv.style.display = 'block';

    // Add title
    const titleDiv = document.createElement('div');
    titleDiv.className = 'location-block-title';
    titleDiv.textContent = 'Multiple locations detected nearby. Select a location:';
    locationBlocksDiv.appendChild(titleDiv);

    // Add each location as a block
    locations.forEach(location => {
        const locationBlock = document.createElement('div');
        locationBlock.className = `location-block ${location.confidence}-confidence`;
        locationBlock.dataset.locationId = location.id;

        // Calculate expiration time
        const expiresAt = new Date(location.expiresAt);
        const now = new Date();
        const minutesRemaining = Math.floor((expiresAt - now) / 60000);

        // Create badge text based on confidence
        let badgeText = 'Low Signal';
        let badgeClass = 'badge-danger';

        if (location.confidence === 'high') {
            badgeText = 'Strong Signal';
            badgeClass = 'badge-success';
        } else if (location.confidence === 'medium') {
            badgeText = 'Medium Signal';
            badgeClass = 'badge-warning';
        }

        // Add the distance in meters (rounded to the nearest meter)
        const distance = Math.round(location.distance);

        // Location content
        locationBlock.innerHTML = `
                    <div class="location-name">${location.name}</div>
                    <div class="location-details">
                        <div>Distance: ${distance} meters</div>
                        <div>Expires in: ${minutesRemaining} minutes</div>
                        <div>Method: ${location.attendanceMethod === 'qr' ? 'QR Code + Location' : (location.attendanceMethod === 'code' ? 'Location + Code' : (location.attendanceMethod === 'face' ? 'Face Recognition + Location' : 'Location Only'))}</div>
                    </div>
                    <span class="confidence-badge badge ${badgeClass}">${badgeText}</span>
                `;

        // Add click event
        locationBlock.addEventListener('click', () => selectLocation(location));

        locationBlocksDiv.appendChild(locationBlock);
    });
}

// Function to handle location selection
function selectLocation(location) {
    console.log(`Selected location: ${location.name} (${location.id})`);

    // Set as the current nearby location
    nearbyLocation = location;

    // Update UI
    locationBadge.className = 'badge badge-success';
    locationBadge.textContent = `Location: ${location.name}`;

    // Create or get the back button container
    const locationBlocksDiv = document.getElementById('location-blocks');
    locationBlocksDiv.innerHTML = '';

    // Add back button
    const backButton = document.createElement('button');
    backButton.className = 'back-button';
    backButton.innerHTML = '<span class="icon">â¬…</span> Back to all locations';
    backButton.addEventListener('click', () => {
        // Trigger location check again to show all locations
        if (currentPosition) {
            findNearbyLocationsWithProximity(
                currentPosition.coords.latitude,
                currentPosition.coords.longitude
            );
        }
    });
    locationBlocksDiv.appendChild(backButton);

    // Show location details
    const locationDetails = document.createElement('div');
    locationDetails.className = 'location-block high-confidence';

    // Calculate expiration time
    const expiresAt = new Date(location.expiresAt);
    const now = new Date();
    const minutesRemaining = Math.floor((expiresAt - now) / 60000);

    // Add the distance in meters (rounded to the nearest meter)
    const distance = Math.round(location.distance);

    locationDetails.innerHTML = `
                <div class="location-name">${location.name}</div>
                <div class="location-details">
                    <div>Distance: ${distance} meters</div>
                    <div>Expires in: ${minutesRemaining} minutes</div>
                    <div>Method: ${location.attendanceMethod === 'qr' ? 'QR Code + Location' : (location.attendanceMethod === 'code' ? 'Location + Code' : (location.attendanceMethod === 'face' ? 'Face Recognition + Location' : 'Location Only'))}</div>
                </div>
            `;
    locationBlocksDiv.appendChild(locationDetails);

    // Handle QR verification if required
    if (location.attendanceMethod === 'qr') {
        if (location.qrVerified) {
            methodBadge.textContent = 'Method: QR Verified';
            methodBadge.className = 'badge badge-success';
            scannerContainer.classList.add('hidden');
            stopCamera();
            captureBtn.disabled = false;
        } else {
            methodBadge.textContent = 'Method: QR + Location';
            methodBadge.className = 'badge badge-warning';
            scannerContainer.classList.remove('hidden');
            if (!cameraActive) {
                startCamera();
            }
            captureBtn.disabled = true;
        }
    } else if (location.attendanceMethod === 'code') {
        methodBadge.textContent = 'Method: Code + Location';
        methodBadge.className = 'badge badge-warning';
        scannerContainer.classList.add('hidden');
        stopCamera();
        captureBtn.disabled = false;
    } else {
        methodBadge.textContent = 'Method: Location Only';
        methodBadge.className = 'badge badge-success';
        scannerContainer.classList.add('hidden');
        stopCamera();
        captureBtn.disabled = false;
    }
}

// Legacy mark attendance function (kept for compatibility)
function markAttendance(locationId, options = {}) {
    if (enforceAndroidAppOnly((msg) => showScanResult(msg, 'error'))) {
        return;
    }

    if (!currentUser) {
        showScanResult("User information not available. Please try logging in again.", 'error');
        return;
    }

    if (!locationId) {
        showScanResult("Location information not available. Please try again.", 'error');
        return;
    }

    primeAttendanceNotificationPermission();

    // Verify that the location exists and is active
    const locationRef = ref(database, `locations/${locationId}`);
    get(locationRef).then((snapshot) => {
        if (!snapshot.exists()) {
            showScanResult("This location no longer exists.", 'error');
            return;
        }

        const locationData = snapshot.val();
        const now = new Date();
        const expiresAt = new Date(locationData.expiresAt || now);

        // Check if class is still active / scheduled
        const scheduleInfo = getScheduleInfo(locationData);
        if (scheduleInfo.hasValue && (!scheduleInfo.start || scheduleInfo.start > now)) {
            showScanResult("This class has not started yet.", 'error');
            return;
        }

        if (now > expiresAt) {
            showScanResult("This class has already ended.", 'error');
            return;
        }

        if (locationData.attendanceMethod === 'code' && !options.codeVerified) {
            promptForAttendanceCode(locationData).then((verified) => {
                if (verified) {
                    markAttendance(locationId, { codeVerified: true });
                }
            });
            return;
        }

        const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
        const timeStr = now.toISOString().split('T')[1].slice(0, 8); // HH:MM:SS

        // Create attendance record - with roll numbers and proper null handling
        const attendanceData = {
            userId: currentUser.uid,
            userName: currentUser.name || user.displayName || 'Unknown User',
            userEmail: currentUser.email || 'No Email',
            classRoll: currentUser.classRoll ? String(currentUser.classRoll) : "",  // Ensure string value or empty string
            univRoll: currentUser.univRoll ? String(currentUser.univRoll) : "",     // Ensure string value or empty string
            section: currentUser.section || "",                                     // Ensure string value or empty string
            locationId: locationId,
            locationName: locationData.name || 'Unknown Location',
            date: dateStr,
            time: timeStr,
            timestamp: now.getTime(),
            latitude: currentPosition ? currentPosition.coords.latitude : null,
            longitude: currentPosition ? currentPosition.coords.longitude : null,
            status: 'present',
            verificationMethod: locationData.attendanceMethod || 'location'
        };

        // Check if already marked attendance for this specific class today
        const userAttendanceRef = ref(database, `user_attendance/${currentUser.uid}/${dateStr}/${locationId}`);

        get(userAttendanceRef)
            .then((snapshot) => {
                if (snapshot.exists()) {
                    showScanResult("You have already marked attendance for this class today.", 'warning');
                    return Promise.reject('already_marked');
                }

                // Save to user_attendance (for tracking attended classes)
                const userAttendancePromise = set(userAttendanceRef, attendanceData);

                // Save to attendance_by_location (for admin records)
                const attendanceByLocationRef = ref(database, `attendance_by_location/${locationId}/${dateStr}/${currentUser.uid}`);
                const locationAttendancePromise = set(attendanceByLocationRef, attendanceData);

                return Promise.all([userAttendancePromise, locationAttendancePromise]);
            })
            .then(() => {
                // Show success message but keep the interface for multiple classes
                showScanResult(`Attendance marked successfully for ${locationData.name}!`, 'success');
                notifyAttendanceMarked(locationData.name, now.getTime());

                // Refresh the classes display to show updated status
                if (currentPosition) {
                    findNearbyLocationsWithProximity(
                        currentPosition.coords.latitude,
                        currentPosition.coords.longitude
                    );
                }
            })
            .catch((error) => {
                if (error === 'already_marked' || error === 'user_cancelled') {
                    // Already handled with appropriate message
                    return;
                }
                showScanResult(`Attendance marking failed: ${error.message}`, 'error');
                console.error("Error marking attendance:", error);
            });
    }).catch((error) => {
        showScanResult(`Error verifying location: ${error.message}`, 'error');
        console.error("Error verifying location:", error);
    });
}

// Update map with user location - function kept for compatibility but does nothing
function updateMapWithUserLocation(position) {
    // Map update removed
    console.log("Location updated but map disabled");
}

// Load locations on map - function kept for compatibility but does nothing
function loadLocationsOnMap() {
    // Map loading removed
    console.log("Location loading but map disabled");
}

// Show login status message
function showLoginStatus(message, type) {
    if (showLoginStatus.hideTimer) {
        clearTimeout(showLoginStatus.hideTimer);
        showLoginStatus.hideTimer = null;
    }

    loginStatus.textContent = message;
    loginStatus.className = `status-indicator ${type}`;
    loginStatus.classList.remove('hidden');

    if (type === 'success' || type === 'info') {
        showLoginStatus.hideTimer = setTimeout(() => {
            loginStatus.classList.add('hidden');
            showLoginStatus.hideTimer = null;
        }, 6000);
    }
}

// Show register status message
function showRegisterStatus(message, type) {
    registerStatus.textContent = message;
    registerStatus.className = `status-indicator ${type}`;
    registerStatus.classList.remove('hidden');

    setTimeout(() => {
        registerStatus.classList.add('hidden');
    }, 5000);
}

// Force section input to uppercase as user types
const regSectionInput = document.getElementById('reg-section');
if (regSectionInput) {
    regSectionInput.addEventListener('input', () => {
        regSectionInput.value = regSectionInput.value.toUpperCase();
    });
}

// Show location status message
function showLocationStatus(message, type) {
    locationStatus.textContent = message;
    locationStatus.className = `status-indicator ${type}`;
    locationStatus.classList.remove('hidden');
}

// Check authentication state changes
onAuthStateChanged(auth, (user) => {
    if (user && isRegistering) {
        return;
    }
    if (user) {
        if (isIOSDevice && !isIOSSafari) {
            showLoginStatus('On iPhone, please use Safari to log in.', 'error');
            signOut(auth);
            return;
        }
        // User is signed in
        const cachedUser = getCachedUserData(user.uid);
        if (cachedUser) {
            currentUser = {
                uid: user.uid,
                email: cachedUser.email || user.email,
                name: cachedUser.name || user.displayName || user.email.split('@')[0],
                role: cachedUser.role || 'student',
                classRoll: cachedUser.classRoll,
                univRoll: cachedUser.univRoll,
                section: cachedUser.section,
                profilePhoto: cachedUser.profilePhoto || null,
                profilePhotoKey: cachedUser.profilePhotoKey || null,
                blocked: cachedUser.blocked || false
            };
            window.currentUser = currentUser;
            applyAndroidDownloadCreditsFromUserData(cachedUser);

            if (currentUser.blocked === true) {
                showBlockedUserPopup();
                signOut(auth);
                return;
            }

            if (currentUser.role === 'admin') {
                window.location.href = './admin';
                return;
            }
            showAttendanceSection();
        }

        getUserData(user);
    } else {
        // User is signed out
        currentUser = null;
        window.currentUser = null;

        cleanupAttendanceListener();
        stopLocationTracking();

        // Make sure camera is stopped when logging out
        if (cameraActive) {
            console.log("Stopping camera during logout");
            stopCamera();
        }

        loginSection.classList.remove('hidden');
        registerSection.classList.add('hidden');
        attendanceSection.classList.add('hidden');

        // Clear form inputs (keep saved email for convenience)
        emailInput.value = getSavedEmail() || '';
        passwordInput.value = '';
    }
});

// Manual attendance button (now hidden in favor of individual class buttons)
captureBtn.addEventListener('click', () => {
    if (enforceAndroidAppOnly((msg) => showScanResult(msg, 'error'))) {
        return;
    }
    showScanResult("Please use the individual class buttons below to mark attendance.", 'info');
});

// Show result message
function showScanResult(message, type) {
    resultMessage.textContent = message;
    scanResult.className = `scan-result ${type}`;
    scanResult.classList.remove('hidden');

    setTimeout(() => {
        scanResult.classList.add('hidden');
    }, 5000);
}

function estimateDigitalMaxForStream(stream, fallbackMax = 3) {
    if (!stream || typeof stream.getVideoTracks !== 'function') {
        return fallbackMax;
    }

    const track = stream.getVideoTracks()[0];
    if (!track) {
        return fallbackMax;
    }

    if (typeof track.getCapabilities === 'function') {
        try {
            const caps = track.getCapabilities();
            if (caps && caps.zoom && typeof caps.zoom.max === 'number' && caps.zoom.max > 1) {
                return caps.zoom.max;
            }
        } catch (error) {
            // Ignore capability probing errors
        }
    }

    if (typeof track.getSettings !== 'function') {
        return fallbackMax;
    }

    const settings = track.getSettings();
    const width = typeof settings.width === 'number' ? settings.width : 0;
    const height = typeof settings.height === 'number' ? settings.height : 0;
    const minDimension = Math.min(width, height);
    if (!minDimension) {
        return fallbackMax;
    }

    const maxFromResolution = Math.floor(minDimension / (QR_SCAN_MAX_DIMENSION * 0.85));
    const clamped = Math.max(2, Math.min(10, maxFromResolution));
    return Math.max(fallbackMax, clamped);
}

function createZoomController(elements, options = {}) {
    if (!elements || !elements.container || !elements.range || !elements.zoomIn || !elements.zoomOut) {
        return null;
    }

    const digitalMin = typeof options.digitalMin === 'number' ? options.digitalMin : 1;
    const fallbackDigitalMax = typeof options.digitalMax === 'number' ? options.digitalMax : 3;
    const digitalStep = typeof options.digitalStep === 'number' ? options.digitalStep : 0.1;
    const enableDigital = options.enableDigitalZoom === true;
    const getDigitalMax = typeof options.getDigitalMax === 'function' ? options.getDigitalMax : null;

    const state = {
        track: null,
        stream: null,
        min: 1,
        max: 1,
        step: 0.1,
        decimals: 1,
        mode: 'none'
    };

    function clamp(value) {
        return Math.min(state.max, Math.max(state.min, value));
    }

    function getStepDecimals(step) {
        const stepText = String(step);
        const dot = stepText.indexOf('.');
        return dot === -1 ? 0 : stepText.length - dot - 1;
    }

    function updateUI(value) {
        const clamped = clamp(value);
        elements.range.value = clamped;
        if (elements.value) {
            elements.value.textContent = `${clamped.toFixed(state.decimals)}x`;
        }
        if (typeof options.onZoomChange === 'function') {
            options.onZoomChange(clamped, state.mode);
        }
    }

    function applyZoom(value) {
        const clamped = clamp(value);
        if (state.mode === 'hardware' && state.track && typeof state.track.applyConstraints === 'function') {
            state.track.applyConstraints({ advanced: [{ zoom: clamped }] })
                .then(() => updateUI(clamped))
                .catch((error) => {
                    console.log('Zoom update failed:', error);
                    if (enableDigital && state.mode === 'hardware') {
                        setupDigital(state.stream);
                        updateUI(clamped);
                    }
                });
            return;
        }
        if (state.mode === 'digital') {
            updateUI(clamped);
        }
    }

    function attach(stream) {
        state.stream = stream || null;
        if (!stream || typeof stream.getVideoTracks !== 'function') {
            if (enableDigital) {
                setupDigital(stream);
                return;
            }
            reset();
            return;
        }

        const track = stream.getVideoTracks()[0];
        if (!track || typeof track.getCapabilities !== 'function') {
            if (enableDigital) {
                setupDigital(stream);
                return;
            }
            reset();
            return;
        }

        let capabilities = null;
        try {
            capabilities = track.getCapabilities();
        } catch (error) {
            capabilities = null;
        }

        const hasZoomCaps = capabilities && capabilities.zoom;
        const min = hasZoomCaps && typeof capabilities.zoom.min === 'number' ? capabilities.zoom.min : 1;
        const max = hasZoomCaps && typeof capabilities.zoom.max === 'number' ? capabilities.zoom.max : 1;

        if (hasZoomCaps && max > min) {
            state.min = min;
            state.max = max;
            state.step = typeof capabilities.zoom.step === 'number' && capabilities.zoom.step > 0 ? capabilities.zoom.step : 0.1;
            state.decimals = getStepDecimals(state.step);

            const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
            const current = typeof settings.zoom === 'number' ? settings.zoom : state.min;

            elements.range.min = state.min;
            elements.range.max = state.max;
            elements.range.step = state.step;
            state.track = track;
            state.mode = 'hardware';

            updateUI(current);
            elements.container.classList.remove('hidden');
            return;
        }

        if (enableDigital) {
            setupDigital(stream);
            return;
        }

        reset();
    }

    function resolveDigitalMax(stream) {
        let resolvedMax = fallbackDigitalMax;
        if (getDigitalMax) {
            const dynamicMax = getDigitalMax(stream, fallbackDigitalMax);
            if (Number.isFinite(dynamicMax) && dynamicMax > digitalMin) {
                resolvedMax = dynamicMax;
            }
        }
        if (!Number.isFinite(resolvedMax) || resolvedMax <= digitalMin) {
            resolvedMax = digitalMin + digitalStep;
        }
        return resolvedMax;
    }

    function setupDigital(stream) {
        const resolvedMax = resolveDigitalMax(stream);
        if (!enableDigital || resolvedMax <= digitalMin) {
            reset();
            return;
        }
        state.min = digitalMin;
        state.max = resolvedMax;
        state.step = digitalStep;
        state.decimals = getStepDecimals(state.step);
        state.track = null;
        state.mode = 'digital';
        elements.range.min = state.min;
        elements.range.max = state.max;
        elements.range.step = state.step;
        updateUI(state.min);
        elements.container.classList.remove('hidden');
    }

    function reset() {
        state.track = null;
        state.stream = null;
        state.mode = 'none';
        elements.container.classList.add('hidden');
        if (typeof options.onZoomChange === 'function') {
            options.onZoomChange(1, 'none');
        }
    }

    if (!elements.container.dataset.zoomBound) {
        elements.range.addEventListener('input', () => {
            const nextValue = parseFloat(elements.range.value);
            applyZoom(Number.isFinite(nextValue) ? nextValue : state.min);
        });

        elements.zoomIn.addEventListener('click', () => {
            const current = parseFloat(elements.range.value);
            const nextValue = Number.isFinite(current) ? current + state.step : state.min + state.step;
            applyZoom(nextValue);
        });

        elements.zoomOut.addEventListener('click', () => {
            const current = parseFloat(elements.range.value);
            const nextValue = Number.isFinite(current) ? current - state.step : state.min - state.step;
            applyZoom(nextValue);
        });

        elements.container.dataset.zoomBound = 'true';
    }

    return {
        attach,
        reset
    };
}

scannerZoomController = createZoomController({
    container: scannerZoomControls,
    range: scannerZoomRange,
    zoomIn: scannerZoomIn,
    zoomOut: scannerZoomOut,
    value: scannerZoomValue
}, {
    enableDigitalZoom: true,
    digitalMax: 3,
    digitalStep: 0.1,
    getDigitalMax: estimateDigitalMaxForStream,
    onZoomChange: (value, mode) => {
        scannerZoomInfo = { value, mode };
        applyDigitalZoomToVideo(video, scannerZoomInfo);
    }
});

function getScanCanvasDimensions(videoWidth, videoHeight) {
    const scale = Math.min(1, QR_SCAN_MAX_DIMENSION / videoWidth, QR_SCAN_MAX_DIMENSION / videoHeight);
    return {
        width: Math.max(1, Math.round(videoWidth * scale)),
        height: Math.max(1, Math.round(videoHeight * scale))
    };
}

function getCanvasContext(canvasEl) {
    if (!canvasEl) return null;
    if (!canvasEl._scanCtx) {
        canvasEl._scanCtx = canvasEl.getContext('2d', { willReadFrequently: true });
    }
    return canvasEl._scanCtx;
}

function applyDigitalZoomToVideo(videoEl, zoomInfo) {
    if (!videoEl || !zoomInfo) return;
    const shouldScale = zoomInfo.mode === 'digital' && zoomInfo.value > 1;
    if (shouldScale) {
        videoEl.style.transformOrigin = 'center center';
        videoEl.style.transform = `scale(${zoomInfo.value})`;
        videoEl.style.willChange = 'transform';
    } else {
        videoEl.style.transform = 'scale(1)';
        videoEl.style.willChange = 'auto';
    }
}

function parseAttendanceQrPayload(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') return null;

    try {
        const parsed = JSON.parse(rawValue);
        if (parsed && parsed.type === 'attendance' && parsed.locationId) {
            return { type: 'attendance', locationId: parsed.locationId };
        }
    } catch (error) {
        // Ignore JSON parsing errors and fall back to compact payloads
    }

    const trimmed = rawValue.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (lower.startsWith('rc:')) {
        return { type: 'attendance', locationId: trimmed.slice(3) };
    }
    if (lower.startsWith('a:')) {
        return { type: 'attendance', locationId: trimmed.slice(2) };
    }

    return null;
}

function drawVideoToScanCanvas(videoEl, canvasEl, zoomInfo) {
    if (!videoEl || !canvasEl || !videoEl.videoWidth || !videoEl.videoHeight) {
        return false;
    }

    const { width, height } = getScanCanvasDimensions(videoEl.videoWidth, videoEl.videoHeight);
    if (canvasEl.width !== width || canvasEl.height !== height) {
        canvasEl.width = width;
        canvasEl.height = height;
    }

    const ctx = getCanvasContext(canvasEl);
    if (!ctx) return false;

    const useDigitalZoom = zoomInfo && zoomInfo.mode === 'digital' && zoomInfo.value > 1;
    const zoom = useDigitalZoom ? zoomInfo.value : 1;
    const srcWidth = videoEl.videoWidth / zoom;
    const srcHeight = videoEl.videoHeight / zoom;
    const srcX = (videoEl.videoWidth - srcWidth) / 2;
    const srcY = (videoEl.videoHeight - srcHeight) / 2;

    ctx.drawImage(videoEl, srcX, srcY, srcWidth, srcHeight, 0, 0, canvasEl.width, canvasEl.height);
    return true;
}

// Start camera for QR scanning
async function startCamera() {
    if (enforceAndroidAppOnly((msg) => showLocationStatus(msg, 'error'))) {
        return;
    }
    // If camera is already active, don't start it again
    if (cameraActive) {
        console.log("Camera already active - not starting again");
        return;
    }

    try {
        showLocationStatus("Preparing QR scanner...", 'info');
        await ensureJsQrLoaded();
    } catch (error) {
        console.error("Failed to load QR scanner:", error);
        showLocationStatus("QR scanner failed to load. Please try again.", 'error');
        return;
    }

    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        console.log("Starting camera...");

        navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: "environment",
                width: { ideal: CAMERA_IDEAL_WIDTH },
                height: { ideal: CAMERA_IDEAL_HEIGHT }
            }
        })
            .then((stream) => {
                video.srcObject = stream;
                cameraActive = true;

                if (scannerZoomController) {
                    scannerZoomController.attach(stream);
                }

                // Start continuous QR scanning
                scanIntervalId = setInterval(scanQRCode, QR_CAMERA_SCAN_INTERVAL_MS);

                console.log("Camera started successfully");
            })
            .catch((error) => {
                console.error("Camera error:", error);
                showLocationStatus("Error accessing camera. Please ensure camera permissions are granted.", 'error');

                // Hide scanner if camera fails
                scannerContainer.classList.add('hidden');
                cameraActive = false;
                if (scannerZoomController) {
                    scannerZoomController.reset();
                }

                // Update method badge
                methodBadge.className = 'badge badge-danger';
                methodBadge.textContent = 'Method: Camera Error';
            });
    } else {
        showLocationStatus("Your browser doesn't support camera access.", 'error');

        // Hide scanner if not supported
        scannerContainer.classList.add('hidden');
        cameraActive = false;
        if (scannerZoomController) {
            scannerZoomController.reset();
        }

        // Update method badge
        methodBadge.className = 'badge badge-danger';
        methodBadge.textContent = 'Method: Not Supported';
    }
}

// Scan for QR codes
function scanQRCode() {
    if (scanning || !video.videoWidth) return;
    if (typeof window.jsQR !== 'function') return;

    scanning = true;

    const frameDrawn = drawVideoToScanCanvas(video, canvas, scannerZoomInfo);
    const ctx = getCanvasContext(canvas);
    if (!frameDrawn || !ctx) {
        scanning = false;
        return;
    }

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "dontInvert",
    });

    if (code) {
        // QR code found
        const qrData = parseAttendanceQrPayload(code.data);

        if (qrData && qrData.locationId && qrData.locationId === nearbyLocation.id) {
            // Valid QR code for this location
            methodBadge.className = 'badge badge-success';
            methodBadge.textContent = 'QR Code: Valid';

            // Stop scanning and camera
            stopCamera();

            // Hide scanner after successful scan
            scannerContainer.classList.add('hidden');

            // Enable the mark attendance button
            captureBtn.disabled = false;

            // Set a flag to prevent the camera from reopening automatically
            // until the user actually changes location
            nearbyLocation.qrVerified = true;

            // Update the location block if visible
            const locationBlocksDiv = document.getElementById('location-blocks');
            if (locationBlocksDiv && locationBlocksDiv.style.display !== 'none') {
                // Find the selected location block and update it
                const locationDetails = locationBlocksDiv.querySelector('.location-block');
                if (locationDetails) {
                    // Add a verification indicator
                    const verifiedBadge = document.createElement('div');
                    verifiedBadge.className = 'badge badge-success';
                    verifiedBadge.style.position = 'absolute';
                    verifiedBadge.style.bottom = '15px';
                    verifiedBadge.style.right = '15px';
                    verifiedBadge.textContent = 'QR Verified';
                    locationDetails.appendChild(verifiedBadge);

                    // Add a button to mark attendance
                    const markButton = document.createElement('button');
                    markButton.className = 'btn btn-success w-100 mt-3';
                    markButton.textContent = 'Mark Attendance';
                    markButton.addEventListener('click', () => markAttendance(nearbyLocation.id));
                    locationDetails.appendChild(markButton);
                }
            }

            showScanResult("QR code valid! You can now mark your attendance.", 'success');
        } else {
            // Invalid QR code (wrong location)
            methodBadge.className = 'badge badge-danger';
            methodBadge.textContent = 'QR Code: Invalid';
            showScanResult("Invalid QR code. Please scan the QR code for this location.", 'error');
        }
    }

    scanning = false;
}

// Stop camera and scanner
function stopCamera() {
    if (!cameraActive) {
        console.log("Camera already stopped");
        return;
    }

    console.log("Stopping camera...");

    if (video.srcObject) {
        const tracks = video.srcObject.getTracks();
        tracks.forEach(track => track.stop());
        video.srcObject = null;
    }

    if (scanIntervalId) {
        clearInterval(scanIntervalId);
        scanIntervalId = null;
    }

    if (scannerZoomController) {
        scannerZoomController.reset();
    }

    cameraActive = false;
    console.log("Camera stopped");
}

// Handle Enter key press in login form
emailInput.addEventListener('keyup', function (event) {
    if (event.key === 'Enter') {
        passwordInput.focus();
    }
});

passwordInput.addEventListener('keyup', function (event) {
    if (event.key === 'Enter') {
        loginBtn.click();
    }
});

// Handle Enter key press in registration form
const regInputs = [regName, regEmail, document.getElementById('reg-class-roll'),
    document.getElementById('reg-section'), document.getElementById('reg-univ-roll'),
    document.getElementById('reg-mobile'), document.getElementById('reg-course'),
    regPassword, regPasswordConfirm];

regInputs.forEach((input, index) => {
    if (input) {
        input.addEventListener('keyup', function (event) {
            if (event.key === 'Enter') {
                // If not the last input, focus the next one
                if (index < regInputs.length - 1) {
                    regInputs[index + 1].focus();
                } else {
                    // If last input, trigger register button
                    registerBtn.click();
                }
            }
        });
    }
});



// Function to check user's location
function checkLocation() {
    // Get geolocation
    if (navigator.geolocation) {
        showLocationStatus('Checking your location...', 'loading');

        navigator.geolocation.getCurrentPosition(function (position) {
            // Extract coordinates
            const userLat = position.coords.latitude;
            const userLon = position.coords.longitude;
            const accuracy = position.coords.accuracy;

            // Get user device type for logging
            const isMobile = /Mobi|Android/i.test(navigator.userAgent);
            const deviceType = isMobile ? "Mobile" : "Desktop";

            // Log user's location and device info
            console.log(`USER LOCATION [${deviceType}]:`, {
                latitude: userLat,
                longitude: userLon,
                accuracy: accuracy,
                timestamp: new Date().toISOString()
            });

            // Normalize coordinates for better device compatibility
            const normalizedCoords = normalizeCoordinates(userLat, userLon, accuracy);

            // Get target location from database
            const attendanceRef = firebase.database().ref('attendance_locations/' + attendanceId);
            attendanceRef.once('value').then(function (snapshot) {
                if (snapshot.exists()) {
                    const data = snapshot.val();

                    // Log target location details for debugging
                    console.log("TARGET LOCATION:", {
                        latitude: data.latitude,
                        longitude: data.longitude,
                        radius: data.radius || 100,
                        name: data.name || "Unknown location"
                    });

                    // Normalize target coordinates too
                    const targetAccuracy = data.accuracy || 10; // Default accuracy if not specified
                    const targetDeviceType = data.deviceType || "unknown"; // Get device type if available
                    const normalizedTarget = normalizeCoordinates(
                        data.latitude,
                        data.longitude,
                        targetAccuracy,
                        targetDeviceType
                    );

                    // Calculate distance and check radius
                    const distance = calculateDistance(
                        userLat, userLon,
                        data.latitude, data.longitude,
                        accuracy, targetAccuracy
                    );

                    // Get radius with a reasonable default
                    const radius = data.radius || 100;

                    // Debug message for distances
                    console.log(`LOCATION CHECK RESULT:`, {
                        distance: `${Math.round(distance)}m`,
                        radius: `${radius}m`,
                        isWithinRadius: distance <= radius,
                        targetLocation: data.name || "Unknown location",
                        userDevice: deviceType,
                        targetDevice: targetDeviceType || "Unknown device"
                    });

                    // Create check result message for the user
                    let statusMessage = '';
                    let statusType = '';

                    if (distance <= radius) {
                        statusMessage = `âœ… Location confirmed! Distance: ${Math.round(distance)}m`;
                        statusType = 'success';

                        // Show the check-in button if location is confirmed
                        const checkInBtn = document.getElementById('check-in-btn');
                        if (checkInBtn) {
                            checkInBtn.classList.remove('d-none');
                        }
                    } else {
                        statusMessage = `âŒ Not at the required location. Distance: ${Math.round(distance)}m (radius: ${radius}m)`;
                        statusType = 'error';

                        // Hide the check-in button if not at location
                        const checkInBtn = document.getElementById('check-in-btn');
                        if (checkInBtn) {
                            checkInBtn.classList.add('d-none');
                        }
                    }

                    // Update UI with check result
                    showLocationStatus(statusMessage, statusType);

                    // Update badges if they exist
                    const locationBadge = document.getElementById('location-status');
                    const methodBadge = document.getElementById('verification-method');

                    if (locationBadge) {
                        locationBadge.innerText = distance <= radius ? 'On-site' : 'Off-site';
                        locationBadge.className = '';
                        locationBadge.classList.add('badge', distance <= radius ? 'bg-success' : 'bg-danger');
                    }

                    if (methodBadge) {
                        methodBadge.innerText = 'GPS';
                        methodBadge.className = '';
                        methodBadge.classList.add('badge', 'bg-info');
                    }

                } else {
                    console.error("Attendance location not found");
                    showLocationStatus("Error: Attendance location not found in database", "error");
                }
            }).catch(function (error) {
                console.error("Error getting attendance location: ", error);
                showLocationStatus("Error retrieving location data", "error");
            });

        }, function (error) {
            console.error("Geolocation error:", error);

            let errorMessage = "Error getting your location";

            switch (error.code) {
                case error.PERMISSION_DENIED:
                    errorMessage = "Location permission denied. Please enable location services.";
                    break;
                case error.POSITION_UNAVAILABLE:
                    errorMessage = "Location information unavailable. Check your device settings.";
                    break;
                case error.TIMEOUT:
                    errorMessage = "Location request timed out. Please try again.";
                    break;
            }

            showLocationStatus(errorMessage, "error");

            // Update badges if they exist
            const locationBadge = document.getElementById('location-status');
            const methodBadge = document.getElementById('verification-method');

            if (locationBadge) {
                locationBadge.innerText = 'Error';
                locationBadge.className = '';
                locationBadge.classList.add('badge', 'bg-warning');
            }

            if (methodBadge) {
                methodBadge.innerText = 'Failed';
                methodBadge.className = '';
                methodBadge.classList.add('badge', 'bg-warning');
            }
        });
    } else {
        showLocationStatus("Geolocation is not supported by this browser", "error");
    }
}

// Handle received peer data
function handleReceivedData(data) {
    console.log("Received data from peer:", data);

    // Verify if data contains location information
    if (data && data.type === 'location' && data.lat && data.lon) {
        // Show the peer's coordinates in the UI
        document.getElementById('peer-coordinates').textContent =
            `Lat: ${data.lat.toFixed(6)}, Lon: ${data.lon.toFixed(6)}`;

        // Set status as received
        document.getElementById('peer-status').textContent = 'Location received';
        document.getElementById('peer-status').className = 'status-indicator received';

        // Get current position to compare
        navigator.geolocation.getCurrentPosition(function (position) {
            // Get user coordinates
            const userLat = position.coords.latitude;
            const userLon = position.coords.longitude;
            const userAccuracy = position.coords.accuracy;

            // Get device info
            const isMobile = /Mobi|Android/i.test(navigator.userAgent);
            const deviceType = isMobile ? "Mobile" : "Desktop";

            // Log current user location for debugging
            console.log(`PEER VERIFICATION - YOUR DEVICE [${deviceType}]:`, {
                latitude: userLat,
                longitude: userLon,
                accuracy: userAccuracy
            });

            // Log peer location for debugging
            console.log("PEER VERIFICATION - OTHER DEVICE:", {
                latitude: data.lat,
                longitude: data.lon,
                accuracy: data.accuracy || 0,
                deviceType: data.deviceType || "Unknown"
            });

            // Calculate distance with our improved algorithm
            const distance = calculateDistance(
                userLat, userLon,
                data.lat, data.lon,
                userAccuracy,
                data.accuracy || 0
            );

            // Determine match threshold (initially 100m or using radius if available)
            let matchThreshold = 100;

            // If the attendance location has a specific radius, use that
            // This value could be passed from the parent context
            if (window.attendanceRadius) {
                matchThreshold = window.attendanceRadius;
            }

            // Adjust threshold for cross-device verification
            if (deviceType !== data.deviceType) {
                // More generous threshold for cross-device verification
                matchThreshold = Math.max(matchThreshold, 150);
            }

            // Log verification details
            console.log("PEER VERIFICATION RESULT:", {
                distance: distance,
                threshold: matchThreshold,
                isMatch: distance <= matchThreshold,
                yourDevice: deviceType,
                peerDevice: data.deviceType
            });

            // Update the match result in the UI
            const resultElement = document.getElementById('peer-match-result');

            if (distance <= matchThreshold) {
                // Locations match
                resultElement.innerHTML = `
                            <div class="match-result success">
                                <i class="fas fa-check-circle"></i>
                                <span>Locations match!</span>
                                <div class="match-details">
                                    <div>Distance: ${Math.round(distance)}m</div>
                                    <div>Threshold: ${matchThreshold}m</div>
                                </div>
                            </div>
                        `;
                // Show success toast
                showToast("Location verified successfully!", "success");
            } else {
                // Locations don't match
                resultElement.innerHTML = `
                            <div class="match-result error">
                                <i class="fas fa-times-circle"></i>
                                <span>Locations don't match</span>
                                <div class="match-details">
                                    <div>Distance: ${Math.round(distance)}m</div>
                                    <div>Threshold: ${matchThreshold}m</div>
                                </div>
                            </div>
                        `;
                // Show error toast
                showToast("Location verification failed. Ensure both devices are at the same location.", "error");
            }

            // Update verification method badge if it exists
            const methodBadge = document.getElementById('verification-method');
            if (methodBadge) {
                methodBadge.innerText = 'Peer';
                methodBadge.className = '';
                methodBadge.classList.add('badge', 'bg-primary');
            }

        }, function (error) {
            console.error("Geolocation error during peer verification:", error);
            document.getElementById('peer-match-result').innerHTML = `
                        <div class="match-result error">
                            <i class="fas fa-exclamation-triangle"></i>
                            <span>Error getting your location</span>
                        </div>
                    `;

            // Show error toast
            showToast("Couldn't access your location. Please enable location services.", "error");
        });
    } else {
        console.error("Received invalid data format:", data);
        document.getElementById('peer-status').textContent = 'Invalid data received';
        document.getElementById('peer-status').className = 'status-indicator error';

        // Show warning toast
        showToast("Received invalid data from peer device.", "warning");
    }
}

"use strict";


/* =========================================================
   HELPERS
   ========================================================= */

const $ = (selector) =>
    document.querySelector(selector);


const $$ = (selector) =>
    document.querySelectorAll(selector);


let csrfToken = "";

let mediaStream = null;

let mediaRecorder = null;

let chunks = [];

let lastRecording = null;

let lastAnalysis = null;

let recordingStartedAt = 0;

let recordingTimer = null;

let audioContext = null;

let analyser = null;

let animationFrame = null;


const MAX_RECORDING_SECONDS = 180;


/* =========================================================
   DOM
   ========================================================= */

const auth =
    $("#auth");

const app =
    $("#app");

const authForm =
    $("#auth-form");

const authSubmit =
    $("#auth-submit");

const authSwitch =
    $("#auth-switch");

const usernameInput =
    $("#user");

const passwordInput =
    $("#pass");

const message =
    $("#msg");

const logoutButton =
    $("#logout");

const startButton =
    $("#start");

const stopButton =
    $("#stop");

const saveButton =
    $("#save");

const fileInput =
    $("#fi");

const fileResult =
    $("#fr");

const verdict =
    $("#verdict");

const confidence =
    $("#confidence");

const circleStatus =
    $("#circle-status");

const detectorOrb =
    document.querySelector(
        ".detector-orb"
    );

const recordingTimerElement =
    $("#recording-timer");

const statusElement =
    $("#status");


/* =========================================================
   CSRF
   ========================================================= */

async function getCSRF() {

    const response =
        await fetch(
            "/api/csrf",
            {
                method: "GET",

                credentials:
                    "same-origin",

                cache:
                    "no-store"
            }
        );


    if (!response.ok) {

        throw new Error(
            "Unable to initialize security session."
        );

    }


    const data =
        await response.json();


    csrfToken =
        data.csrf_token;


    return csrfToken;
}


/* =========================================================
   API
   ========================================================= */

async function api(
    url,
    options = {}
) {

    const method =
        (
            options.method ||
            "GET"
        ).toUpperCase();


    const headers =
        new Headers(
            options.headers ||
            {}
        );


    if (
        method !== "GET" &&
        method !== "HEAD"
    ) {

        await getCSRF();

        headers.set(
            "X-CSRF-Token",
            csrfToken
        );

    }


    const response =
        await fetch(
            url,
            {
                ...options,

                method,

                headers,

                credentials:
                    "same-origin",

                cache:
                    "no-store"
            }
        );


    const data =
        await response
            .json()
            .catch(
                () => ({})
            );


    if (!response.ok) {

        throw new Error(
            data.detail ||
            `Request failed (${response.status})`
        );

    }


    return data;
}


/* =========================================================
   AUTH STATE
   ========================================================= */

function showAuth() {

    auth.classList.remove(
        "hidden"
    );

    app.classList.add(
        "hidden"
    );

}


function showApp() {

    auth.classList.add(
        "hidden"
    );

    app.classList.remove(
        "hidden"
    );

}


function setMessage(
    text,
    error = false
) {

    message.textContent =
        text;

    message.classList.toggle(
        "error",
        error
    );

}


/* =========================================================
   AUTH MODE
   ========================================================= */

let registerMode = false;


function updateAuthMode() {

    if (registerMode) {

        $("#auth-eyebrow")
            .textContent =
            "NEW PRIVATE IDENTITY";

        $("#auth-title")
            .textContent =
            "CREATE GHOSTVOICE";

        $("#auth-description")
            .textContent =
            "Create a private account for your encrypted workspace.";

        authSubmit.textContent =
            "CREATE ACCOUNT";

        authSwitch.textContent =
            "BACK TO SIGN IN";

        passwordInput
            .setAttribute(
                "autocomplete",
                "new-password"
            );

    } else {

        $("#auth-eyebrow")
            .textContent =
            "PRIVATE MODE";

        $("#auth-title")
            .textContent =
            "ENTER GHOSTVOICE";

        $("#auth-description")
            .textContent =
            "Sign in to access your private analysis workspace.";

        authSubmit.textContent =
            "SIGN IN";

        authSwitch.textContent =
            "CREATE ACCOUNT";

        passwordInput
            .setAttribute(
                "autocomplete",
                "current-password"
            );

    }

}


authSwitch.addEventListener(
    "click",
    () => {

        registerMode =
            !registerMode;

        setMessage(
            ""
        );

        updateAuthMode();

    }
);


/* =========================================================
   LOGIN / REGISTER
   ========================================================= */

authForm.addEventListener(
    "submit",
    async (event) => {

        event.preventDefault();

        setMessage(
            ""
        );

        authSubmit.disabled =
            true;


        try {

            const payload = {

                username:
                    usernameInput
                        .value
                        .trim(),

                password:
                    passwordInput
                        .value

            };


            await getCSRF();


            const endpoint =
                registerMode
                    ? "/api/register"
                    : "/api/login";


            await api(
                endpoint,
                {
                    method:
                        "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body:
                        JSON.stringify(
                            payload
                        )
                }
            );


            showApp();

            setMessage(
                ""
            );

            await loadLibrary();

            statusElement.textContent =
                "SECURE SESSION";


        } catch (error) {

            setMessage(
                error.message,
                true
            );

        } finally {

            authSubmit.disabled =
                false;

        }

    }
);


/* =========================================================
   SESSION CHECK
   ========================================================= */

async function checkSession() {

    try {

        await api(
            "/api/me"
        );

        showApp();

        await loadLibrary();

    } catch {

        showAuth();

    }

}


/* =========================================================
   LOGOUT
   ========================================================= */

logoutButton.addEventListener(
    "click",
    async () => {

        logoutButton.disabled =
            true;

        try {

            await api(
                "/api/logout",
                {
                    method:
                        "POST"
                }
            );

        } catch (error) {

            console.error(
                error
            );

        } finally {

            stopRecording();

            showAuth();

            logoutButton.disabled =
                false;

            usernameInput.value =
                "";

            passwordInput.value =
                "";

            statusElement.textContent =
                "SECURE ENGINE";

        }

    }
);


/* =========================================================
   TABS
   ========================================================= */

$$(".tab").forEach(
    (tab) => {

        tab.addEventListener(
            "click",
            async () => {

                const target =
                    tab.dataset.t;

                $$(".tab")
                    .forEach(
                        x =>
                            x.classList.remove(
                                "active"
                            )
                    );

                tab.classList.add(
                    "active"
                );


                $$(".panel")
                    .forEach(
                        panel => {

                            panel.classList.toggle(
                                "hidden",
                                panel.id !==
                                    target
                            );

                        }
                    );


                if (
                    target ===
                    "library"
                ) {

                    await loadLibrary();

                }

            }
        );

    }
);


/* =========================================================
   CIRCLE STATE
   ========================================================= */

function setCircleState(
    state
) {

    if (!circleStatus) {
        return;
    }


    circleStatus.textContent =
        state;


    if (
        detectorOrb
    ) {

        detectorOrb.classList.toggle(
            "encrypting",
            state ===
                "ENCRYPTING"
        );

    }

}


/* =========================================================
   RESULT
   ========================================================= */

function verdictLabel(
    value
) {

    if (
        value ===
        "AI_GENERATED"
    ) {

        return "AI-GENERATED";

    }

    return value;

}


function showResult(result) {

    lastAnalysis = result;

    const rawVerdict =
        String(result.verdict || "")
            .trim()
            .toUpperCase();

    const probability =
        Math.round(
            (
                result.ai_probability || 0
            ) * 100
        );

    const conf =
        Math.round(
            (
                result.confidence || 0
            ) * 100
        );


    /*
     * Determine visual result state.
     *
     * AI-GENERATED  -> red
     * HUMAN         -> green
     * UNCERTAIN     -> yellow
     */

    let resultState = "uncertain";

    if (
        rawVerdict === "AI_GENERATED" ||
        rawVerdict === "AI-GENERATED" ||
        rawVerdict === "AI"
    ) {

        resultState = "ai";

    } else if (
        rawVerdict === "HUMAN"
    ) {

        resultState = "human";

    } else if (
        rawVerdict === "UNCERTAIN"
    ) {

        resultState = "uncertain";

    }


    /*
     * Update the LIVE result.
     */

    verdict.textContent =
        verdictLabel(
            result.verdict
        );

    confidence.textContent =
        `AI probability ${probability}% · ` +
        `analysis confidence ${conf}% · ` +
        `${result.windows || 0} windows`;


    /*
     * Apply color to the live verdict.
     */

    verdict.classList.remove(
        "result-ai",
        "result-human",
        "result-uncertain"
    );

    verdict.classList.add(
        `result-${resultState}`
    );


    /*
     * Update the central circle state.
     */

    setCircleState(
        verdictLabel(
            result.verdict
        )
    );


    /*
     * Apply color to the recording result card.
     */

    if (fileResult) {

        fileResult.classList.remove(
            "result-ai",
            "result-human",
            "result-uncertain"
        );

        fileResult.classList.add(
            `result-${resultState}`
        );


        fileResult.innerHTML = `
            <span class="eyebrow">
                ANALYSIS RESULT
            </span>

            <strong>
                ${escapeHtml(
                    verdictLabel(
                        result.verdict
                    )
                )}
            </strong>

            <div class="result-metrics">

                <span>
                    AI probability:
                    <b>${probability}%</b>
                </span>

                <span>
                    Confidence:
                    <b>${conf}%</b>
                </span>

                <span>
                    Windows:
                    <b>${result.windows || 0}</b>
                </span>

            </div>
        `;
    }

}


/* =========================================================
   HTML ESCAPING
   ========================================================= */

function escapeHtml(
    value
) {

    return String(
        value
    )
        .replaceAll(
            "&",
            "&amp;"
        )
        .replaceAll(
            "<",
            "&lt;"
        )
        .replaceAll(
            ">",
            "&gt;"
        )
        .replaceAll(
            '"',
            "&quot;"
        )
        .replaceAll(
            "'",
            "&#039;"
        );

}


/* =========================================================
   RECORDING TIMER
   ========================================================= */

function formatTime(
    seconds
) {

    const minutes =
        Math.floor(
            seconds / 60
        );

    const secs =
        seconds % 60;


    return (
        String(minutes)
            .padStart(2, "0")
        +
        ":"
        +
        String(secs)
            .padStart(2, "0")
    );

}


function updateRecordingTimer() {

    if (
        !recordingStartedAt
    ) {

        return;

    }


    const elapsed =
        Math.floor(
            (
                Date.now()
                -
                recordingStartedAt
            ) / 1000
        );


    const safeElapsed =
        Math.min(
            elapsed,
            MAX_RECORDING_SECONDS
        );


    if (
        recordingTimerElement
    ) {

        recordingTimerElement.textContent =
            `${formatTime(
                safeElapsed
            )} / 03:00`;

    }


    if (
        elapsed >=
        MAX_RECORDING_SECONDS
    ) {

        stopRecording();

    }

}


function startRecordingTimer() {

    recordingStartedAt =
        Date.now();


    clearInterval(
        recordingTimer
    );


    recordingTimer =
        setInterval(
            updateRecordingTimer,
            250
        );


    updateRecordingTimer();

}


function stopRecordingTimer() {

    clearInterval(
        recordingTimer
    );

    recordingTimer =
        null;

    recordingStartedAt =
        0;


    if (
        recordingTimerElement
    ) {

        recordingTimerElement.textContent =
            "00:00 / 03:00";

    }

}


/* =========================================================
   VISUALIZER
   ========================================================= */

function createVisualizer() {

    const container =
        $("#bars");

    if (!container) {
        return;
    }


    container.innerHTML =
        "";


    for (
        let i = 0;
        i < 36;
        i++
    ) {

        const bar =
            document.createElement(
                "span"
            );

        bar.className =
            "visual-bar";

        bar.style.height =
            `${10 + Math.random() * 30}px`;

        container.appendChild(
            bar
        );

    }

}


function startVisualizer() {

    if (!analyser) {
        return;
    }


    const container =
        $("#bars");

    if (!container) {
        return;
    }


    const data =
        new Uint8Array(
            analyser.frequencyBinCount
        );


    function draw() {

        animationFrame =
            requestAnimationFrame(
                draw
            );


        analyser.getByteFrequencyData(
            data
        );


        const bars =
            container.querySelectorAll(
                ".visual-bar"
            );


        bars.forEach(
            (
                bar,
                index
            ) => {

                const position =
                    Math.floor(
                        (
                            index
                            /
                            bars.length
                        )
                        *
                        data.length
                    );


                const value =
                    data[position] || 0;


                const height =
                    8
                    +
                    (
                        value
                        /
                        255
                    )
                    * 65;


                bar.style.height =
                    `${height}px`;

            }
        );

    }


    draw();

}


function stopVisualizer() {

    if (
        animationFrame
    ) {

        cancelAnimationFrame(
            animationFrame
        );

        animationFrame =
            null;

    }

}


/* =========================================================
   START LIVE RECORDING
   ========================================================= */

startButton.addEventListener(
    "click",
    async () => {

        try {

            mediaStream =
                await navigator
                    .mediaDevices
                    .getUserMedia(
                        {
                            audio: {
                                echoCancellation:
                                    true,

                                noiseSuppression:
                                    false,

                                autoGainControl:
                                    false
                            }
                        }
                    );


            audioContext =
                new (
                    window.AudioContext
                    ||
                    window.webkitAudioContext
                )();


            const source =
                audioContext
                    .createMediaStreamSource(
                        mediaStream
                    );


            analyser =
                audioContext
                    .createAnalyser();


            analyser.fftSize =
                256;


            source.connect(
                analyser
            );


            startVisualizer();


            const mimeCandidates = [
                "audio/webm;codecs=opus",
                "audio/webm",
                "audio/ogg;codecs=opus"
            ];


            let mimeType =
                "";


            for (
                const candidate
                of mimeCandidates
            ) {

                if (
                    MediaRecorder
                        .isTypeSupported(
                            candidate
                        )
                ) {

                    mimeType =
                        candidate;

                    break;

                }

            }


            mediaRecorder =
                mimeType
                    ? new MediaRecorder(
                        mediaStream,
                        {
                            mimeType
                        }
                    )
                    : new MediaRecorder(
                        mediaStream
                    );


            chunks =
                [];


            mediaRecorder
                .ondataavailable =
                (event) => {

                    if (
                        event.data
                        &&
                        event.data.size
                    ) {

                        chunks.push(
                            event.data
                        );

                    }

                };


            mediaRecorder
                .onstop =
                async () => {

                    try {

                        stopVisualizer();


                        const blob =
                            new Blob(
                                chunks,
                                {
                                    type:
                                        mediaRecorder
                                            .mimeType
                                            ||
                                        "audio/webm"
                                }
                            );


                        chunks =
                            [];


                        if (
                            blob.size === 0
                        ) {

                            throw new Error(
                                "No audio was captured."
                            );

                        }


                        lastRecording =
                            blob;


                        verdict.textContent =
                            "ANALYZING";


                        setCircleState(
                            "ANALYZING"
                        );


                        confidence.textContent =
                            "Examining the recorded voice…";


                        const result =
                            await analyzeRecording(
                                blob
                            );


                        showResult(
                            result
                        );


                        saveButton.disabled =
                            false;


                    } catch (
                        error
                    ) {

                        console.error(
                            error
                        );


                        verdict.textContent =
                            "ERROR";


                        setCircleState(
                            "ERROR"
                        );


                        confidence.textContent =
                            error.message;


                    } finally {

                        cleanupAudio();

                    }

                };


            mediaRecorder.start(
                1000
            );


            startRecordingTimer();


            startButton.disabled =
                true;

            stopButton.disabled =
                false;

            saveButton.disabled =
                true;


            verdict.textContent =
                "LISTENING";


            setCircleState(
                "LISTENING"
            );


            confidence.textContent =
                "Private capture active — maximum 03:00";


        } catch (error) {

            console.error(
                error
            );


            alert(
                error.message
                ||
                "Microphone access failed."
            );

        }

    }
);


/* =========================================================
   STOP RECORDING
   ========================================================= */

function stopRecording() {

    stopRecordingTimer();


    if (
        mediaRecorder
        &&
        mediaRecorder.state !==
            "inactive"
    ) {

        mediaRecorder.stop();

    }


    startButton.disabled =
        false;

    stopButton.disabled =
        true;

}


stopButton.addEventListener(
    "click",
    stopRecording
);


/* =========================================================
   AUDIO CLEANUP
   ========================================================= */

function cleanupAudio() {

    stopVisualizer();


    if (
        mediaStream
    ) {

        mediaStream
            .getTracks()
            .forEach(
                track =>
                    track.stop()
            );

        mediaStream =
            null;

    }


    if (
        audioContext
    ) {

        audioContext
            .close()
            .catch(
                () => {}
            );

        audioContext =
            null;

    }


    analyser =
        null;

}


/* =========================================================
   ANALYZE RECORDING
   ========================================================= */

async function analyzeRecording(
    blob
) {

    const form =
        new FormData();


    const extension =
        blob.type.includes(
            "ogg"
        )
            ? ".ogg"
            : ".webm";


    form.append(
        "file",
        blob,
        `ghostvoice${extension}`
    );


    return await api(
        "/api/analyze",
        {
            method:
                "POST",

            body:
                form
        }
    );

}


/* =========================================================
   SAVE / ENCRYPT
   ========================================================= */

saveButton.addEventListener(
    "click",
    async () => {

        if (
            !lastRecording
        ) {

            return;

        }


        saveButton.disabled =
            true;


        /*
         * THIS IS THE IMPORTANT PART.
         *
         * Immediately change the text inside
         * the central circle.
         */

        setCircleState(
            "ENCRYPTING"
        );


        verdict.textContent =
            "ENCRYPTING";


        confidence.textContent =
            "Encrypting and securing your recording…";


        saveButton.classList.add(
            "encrypting-button"
        );


        statusElement.textContent =
            "ENCRYPTING STORAGE";


        try {

            const form =
                new FormData();


            const extension =
                lastRecording.type
                    .includes(
                        "ogg"
                    )
                    ? ".ogg"
                    : ".webm";


            form.append(
                "file",
                lastRecording,
                `ghostvoice${extension}`
            );


            const result =
                await api(
                    "/api/analyze-and-save",
                    {
                        method:
                            "POST",

                        body:
                            form
                    }
                );


            /*
             * Encryption completed.
             */

            setCircleState(
                "ENCRYPTED"
            );


            verdict.textContent =
                "ENCRYPTED";


            confidence.textContent =
                "Recording encrypted and stored securely.";


            statusElement.textContent =
                "SECURE STORAGE";


            lastAnalysis =
                result;


            lastRecording =
                null;


            await loadLibrary();


        } catch (
            error
        ) {

            console.error(
                error
            );


            setCircleState(
                "ENCRYPTION FAILED"
            );


            verdict.textContent =
                "ERROR";


            confidence.textContent =
                error.message;


            statusElement.textContent =
                "SECURE ENGINE";


            saveButton.disabled =
                false;


        } finally {

            saveButton.classList.remove(
                "encrypting-button"
            );

        }

    }
);


/* =========================================================
   FILE UPLOAD
   ========================================================= */

fileInput.addEventListener(
    "change",
    async () => {

        const file =
            fileInput.files[0];


        if (!file) {
            return;
        }


        if (
            file.size >
            100 *
            1024 *
            1024
        ) {

            fileResult.innerHTML = `
                <span class="eyebrow">
                    ERROR
                </span>

                <strong>
                    File is larger than 100 MB.
                </strong>
            `;

            return;

        }


        fileResult.innerHTML = `
            <span class="eyebrow">
                ANALYZING
            </span>

            <strong>
                Examining your recording…
            </strong>
        `;


        try {

            const form =
                new FormData();


            form.append(
                "file",
                file
            );


            const result =
                await api(
                    "/api/analyze",
                    {
                        method:
                            "POST",

                        body:
                            form
                    }
                );


            showResult(
                result
            );


        } catch (
            error
        ) {

            fileResult.innerHTML = `
                <span class="eyebrow">
                    ERROR
                </span>

                <strong>
                    ${escapeHtml(
                        error.message
                    )}
                </strong>
            `;

        }

    }
);


/* =========================================================
   LIBRARY
   ========================================================= */

async function loadLibrary() {

    const list =
        $("#list");


    if (!list) {
        return;
    }


    list.innerHTML = `
        <div class="result-card glass">
            Loading encrypted recordings…
        </div>
    `;


    try {

        const recordings =
            await api(
                "/api/recordings"
            );


        if (
            !recordings.length
        ) {

            list.innerHTML = `
                <div class="result-card glass">
                    <span class="eyebrow">
                        PRIVATE STORAGE
                    </span>

                    <strong>
                        No encrypted recordings yet.
                    </strong>
                </div>
            `;

            return;

        }


        list.innerHTML =
            recordings
                .map(
                    recording => {

                        const probability =
                            Math.round(
                                recording
                                    .ai_probability
                                * 100
                            );


                        const date =
                            new Date(
                                recording
                                    .created_at
                            )
                                .toLocaleString();


                        return `
                            <div
                                class="library-item glass"
                            >

                                <div>

                                    <span class="eyebrow">
                                        ENCRYPTED RECORDING
                                    </span>

                                    <strong>
                                        ${escapeHtml(
                                            recording.verdict
                                        )}
                                    </strong>

                                    <small>
                                        ${escapeHtml(
                                            date
                                        )}
                                    </small>

                                </div>


                                <div
                                    class="library-actions"
                                >

                                    <button
                                        class="secondary play-recording"
                                        data-id="${escapeHtml(
                                            recording.id
                                        )}"
                                    >
                                        PLAY
                                    </button>

                                    <button
                                        class="secondary delete-recording"
                                        data-id="${escapeHtml(
                                            recording.id
                                        )}"
                                    >
                                        DELETE
                                    </button>

                                </div>

                            </div>
                        `;

                    }
                )
                .join("");


        list
            .querySelectorAll(
                ".play-recording"
            )
            .forEach(
                button => {

                    button.addEventListener(
                        "click",
                        () =>
                            playRecording(
                                button.dataset.id
                            )
                    );

                }
            );


        list
            .querySelectorAll(
                ".delete-recording"
            )
            .forEach(
                button => {

                    button.addEventListener(
                        "click",
                        () =>
                            deleteRecording(
                                button
                            )
                    );

                }
            );


    } catch (
        error
    ) {

        list.innerHTML = `
            <div class="result-card glass">
                <strong>
                    ${escapeHtml(
                        error.message
                    )}
                </strong>
            </div>
        `;

    }

}


/* =========================================================
   PLAY RECORDING
   ========================================================= */

async function playRecording(
    fileId
) {

    try {

        const response =
            await fetch(
                `/api/recordings/${encodeURIComponent(
                    fileId
                )}`,
                {
                    credentials:
                        "same-origin",

                    cache:
                        "no-store"
                }
            );


        if (!response.ok) {

            const data =
                await response
                    .json()
                    .catch(
                        () => ({})
                    );


            throw new Error(
                data.detail ||
                "Unable to load recording."
            );

        }


        const blob =
            await response.blob();


        const url =
            URL.createObjectURL(
                blob
            );


        const audio =
            new Audio(
                url
            );


        audio.onended =
            () =>
                URL.revokeObjectURL(
                    url
                );


        await audio.play();


    } catch (
        error
    ) {

        alert(
            error.message
        );

    }

}


/* =========================================================
   DELETE RECORDING
   ========================================================= */

async function deleteRecording(
    button
) {

    const fileId =
        button.dataset.id;


    if (
        !confirm(
            "Permanently delete this encrypted recording?"
        )
    ) {

        return;

    }


    button.disabled =
        true;


    try {

        await api(
            `/api/recordings/${encodeURIComponent(
                fileId
            )}`,
            {
                method:
                    "DELETE"
            }
        );


        await loadLibrary();


    } catch (
        error
    ) {

        alert(
            error.message
        );


        button.disabled =
            false;

    }

}


/* =========================================================
   INITIALIZATION
   ========================================================= */

createVisualizer();

updateAuthMode();

setCircleState(
    "READY"
);

checkSession();
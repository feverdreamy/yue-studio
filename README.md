# YuE Studio

A Windows desktop for making songs locally with YuE2, with an optional songwriting assistant and experimental continuous radio.

## Download and run

Download **YuE-Studio-Windows-1.4.1.zip** from [Releases](https://github.com/feverdreamy/yue-studio/releases/latest). Use the release ZIP, not GitHub's automatically generated source-code ZIP.

1. Extract the whole ZIP into a writable folder, such as a folder on your Desktop. Do not run it inside the ZIP.
2. Double-click **1 - Install YuE Studio.cmd**. Keep it open until it says Ready.
3. Open **YuE Studio** using its new desktop icon, or double-click **2 - Run YuE Studio.cmd**.

The installer checks and downloads the YuE2 music weights, Ollama runtime and GPU libraries, and **Granite 4.2 3B and 8B**. Downloads use pinned versions and SHA-256 checks. Run Install again to resume interrupted downloads or repair missing files. Existing Ollama models are reused in place: setup respects `OLLAMA_MODELS`, then detects the standard Ollama store. Only missing or damaged Granite files are downloaded. Other installed text models appear in the model picker. An exact matching installed Ollama runtime is also reused to avoid downloading it again.

Allow approximately **13.9 GB of downloads** on a fresh PC, plus this app ZIP, and **25 GB of free disk space** for installation and saved songs. Download time depends on your connection. Internet is required for initial setup; local generation works offline afterward.

Windows 10 22H2 or Windows 11, x64, with a current graphics driver is required. A capable dedicated Vulkan GPU is strongly recommended for music generation. This runtime was tested on a 16 GB AMD GPU; other cards and long songs may have different memory needs. CPU mode is available but can be very slow. The installer does not install or change graphics drivers.

The app reuses a compatible running local Ollama service when it can see Granite 3B. Otherwise it starts its bundled Ollama with the same model store and stops only that private process when the app closes. Existing Ollama services are left running. No separate Python, Node.js, development tools, Ollama installation, account or API key is needed to run the release.

## Make a song

Write lyrics with markers such as `[Verse]` and `[Chorus]`, describe the sound, then Compose. Or open **From an idea**, choose Granite 3B or 8B, write a short brief, and let the assistant draft a title, lyrics and sound direction. Review the draft, choose **Use this draft**, then Compose.

The smaller 3B model is selected first for a lighter writing workload. 8B is also installed and can be selected in the model picker. These models are alternatives for writing and host chat; YuE2 still generates the actual music. A completed comparative songwriting-quality benchmark is not claimed for this release.

- **Preview 30s** generates a shorter test without changing the full composition.
- **Memory check → Try anyway** attempts a take even when RAM, GPU memory or commit headroom falls below the estimate. It may fail if memory runs out. If already waiting, cancel that wait first, select Try anyway, then compose again. Radio has the same option in Station settings.
- **Fine control** includes the seed, sampling, planning mode, duration ceiling, steps and memory options.
- **Takes** preserves finished audio and settings. Seed buttons copy the exact saved seed.
- Trash icons remove tracks and finished attempts. Undo or Trash restores them; permanent deletion frees the space.
- Right-click misspelled words for spelling suggestions or Add to dictionary.
- DeepInfra and OpenAI writing are optional and require the recipient's own API keys and credits.

## Radio

Open **Radio**, set its station idea and sound baseline, select a host model, then Start. It prepares an initial buffer and plays with soft handovers. Generation must keep up to avoid gaps; a limited session is useful for the first trial. Radio stays off after restarting.

Message the host to guide future songs. Visible memories can be added or forgotten. Commands work without a model call:

```text
/remember vocals=softly rapped verses
/forget vocals
/style warm jazz rap, dry drums, rounded bass
/reset
```

Stop cancels radio work. Already prepared songs can reflect the earlier direction. Forgetting removes active context; the visible conversation record is not fed back to the model.

## Privacy and files

The release starts empty: no personal tracks, lyrics, drafts, prompts, host conversations, memories, provider keys or browser profiles are included. Your own work is created under `data/`; exported files go under `exports/`. Back up `data/` to keep your songs. Do not share your working folder without removing its personal data first.

The desktop encrypts saved hosted-provider keys using Windows-backed storage. Local music and local writing do not need hosted accounts.

## Licences and scope

YuE2-3B and its VAE weights are **CC BY-NC 4.0**, requiring attribution and noncommercial use. Sources: [YuE2-3B](https://huggingface.co/m-a-p/YuE2-3B), [VAE](https://huggingface.co/m-a-p/YuE2-Vae), [GGUF conversion](https://huggingface.co/audio-cpp/Yue2-3B-GGUF). This is an independent interface, not an official YuE release.

[audio.cpp](https://github.com/0xShug0/audio.cpp) retains its Apache 2.0 licence. [Granite 4.2](https://huggingface.co/ibm-granite/granite-4.2-3b) is Apache 2.0; [Ollama](https://github.com/ollama/ollama) is MIT. Third-party notices are retained in `licenses`, `runtime/LICENSE`, the Electron desktop licence files, and the downloaded Ollama library directory.

No stems, voice cloning or generated-score export are promised. Supplied ABC notation can be previewed and used as a melody input.

## Development

The release includes the runtime needed to run the app. Building the source instead requires Node.js and pnpm: `pnpm install --frozen-lockfile`, `pnpm build`, then `pnpm package`. Large models, runtime payloads and user data are deliberately excluded from Git. Release assembly uses a verified runtime payload and the files under `distribution/`.

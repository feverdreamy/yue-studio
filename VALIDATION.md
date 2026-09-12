# Windows 1.4.1 release checks

- TypeScript check, production build and Electron packaging passed.
- Desktop shortcut creation passed in an isolated desktop folder. Memory admission tests confirm the default wait and explicit Try anyway behavior for known shortages and missing readings; radio forwards the chosen policy.
- 13 server acceptance checks passed, covering input validation, job cancellation, audio validation/export, persistence and shutdown. These use an injected engine fixture.
- The actual Windows installer completed twice using a small isolated dependency cache and external model store. It preserved unrelated models, registered both writer tags, reused existing files and detected Vulkan devices with the bundled native music engine.
- The real bundled-writer startup code started and stopped an installed Ollama 0.33.3 process in an isolated test. A simulated compatible existing service was reused and remained running when the app closed.
- A freshly extracted release ZIP launched the packaged desktop. Its library, history, trash and radio conversations were empty. Both writing panels selected Granite 3B by default, while an existing alternative model could be selected and remained selected after refreshing.
- The packaged renderer, server and Electron files match their build inputs byte for byte. Bundled runtime/licence hashes, ZIP extraction integrity and personal-path/credential-pattern checks passed.

This release did not complete fresh full-size downloads or an inference comparison of Granite 3B and 8B. The installer uses pinned official download URLs, sizes and SHA-256 hashes. Music performance on other PCs, sustained radio throughput, physical window interactions and a fresh listening review are not established by these checks.

The installer now distinguishes OneDrive cloud placeholders from symbolic links and junctions. Checks used the production manifest extracted with the Windows .NET ZIP reader, simulated cloud placeholder metadata, a real junction and missing-file failures. Cloud placeholders passed; junctions remained blocked; errors were retained in install-log.txt.

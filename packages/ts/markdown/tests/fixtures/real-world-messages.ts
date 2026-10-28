export type RealWorldMarkdownFixture = {
  readonly buckets: readonly string[];
  readonly id: string;
  readonly source: string;
};

export const realWorldMarkdownFixtures = [
  {
    "id": "real-world-001",
    "buckets": [
      "heading",
      "list",
      "ordered-list",
      "code",
      "table",
      "link",
      "html",
      "strong",
      "emphasis",
      "long",
    ],
    "source":
      'Using **[Effect.ts](https://example.com)** for your **client/server streaming logic** could be a **strong fit**, given your requirements and preferences. Here’s why and how it aligns with your context:\n\n---\n\n## **Why Effect.ts?**\n1. **Type Safety & Explicit Error Handling**\n   - Effect’s `Effect<A, E, R>` type lets you model:\n     - **Success (`A`)**: e.g., `PCMFrame` or `JSONPatch`.\n     - **Errors (`E`)**: e.g., `WebSocketError | RedisError | HarmattanError`.\n     - **Dependencies (`R`)**: e.g., `WebSocket | Redis | Harmattan`.\n   - **Example**:\n     ```typescript\n     type StreamError = WebSocketError | RedisError | HarmattanError;\n     const sendPCMFrame: Effect.Effect<void, StreamError, WebSocket | Redis> = /* ... */;\n     ```\n\n2. **Streaming & Concurrency**\n   - Effect’s `Stream` module is built for **backpressure-aware**, **resumable** streams.\n   - **Directly replaces** your `ReadableStream`/`TransformStream` usage with **managed resources** (auto-cleanup on failure).\n   - **Example**:\n     ```typescript\n     const pcms = Stream.fromIterable(pcmFrames)\n       .pipeThrough(Stream.map(encodeFrame))\n       .pipeTo(Stream.runForEach(frame => sendToWebSocket(frame)));\n     ```\n\n3. **Distributed Systems**\n   - **Fibers** (lightweight threads) simplify:\n     - Reconnection logic (retry policies).\n     - Cancellation (via `Effect.interrupt`).\n   - **Example**:\n     ```typescript\n     const program = sendPCMFrame.pipe(\n       Effect.retry({ times: 3, schedule: "exponential" })\n     );\n     ```\n\n4. **Your Preferences**\n   - **Explicit types**: Effect enforces this at compile time.\n   - **Minimal complexity**: Effect’s `Stream` is simpler than manual `ReadableStream` plumbing.\n   - **Cancellation**: Built-in `Effect.interrupt` replaces `AbortSignal`.\n\n---\n\n## **Where It Shines**\n### **1. Client-Side**\n- **WebSocket + Reconnection**:\n  ```typescript\n  const connect = Effect.gen(function*() {\n    const ws = yield* WebSocket;\n    yield* Effect.tryPromise({\n      try: () => ws.send(pcmFrame),\n      catch: () => new WebSocketError("Disconnected"),\n    });\n  }).pipe(Effect.retry({ times: Infinity }));\n  ```\n- **Resumption**:\n  ```typescript\n  const resumeStream = (lastAckedId: number) =>\n    Stream.range(lastAckedId + 1, Infinity)\n      .pipeThrough(Stream.map(fetchFrameFromS3))\n      .pipeTo(Stream.runForEach(sendToWebSocket));\n  ```\n\n### **2. Server-Side**\n- **Harmattan Integration**:\n  ```typescript\n  const processFrame = (frame: PCMFrame) =>\n    Effect.gen(function*() {\n      const harmattan = yield* Harmattan;\n      yield* Effect.tryPromise({\n        try: () => harmattan.process(frame),\n        catch: () => new HarmattanError("Processing failed"),\n      });\n    }).pipe(Effect.retry({ times: 3 }));\n  ```\n- **Redis State**:\n  ```typescript\n  const updateLastSequenceId = (clientId: string, id: number) =>\n    Effect.gen(function*() {\n      const redis = yield* Redis;\n      yield* Effect.tryPromise({\n        try: () => redis.set(`client:${clientId}:last_id`, id),\n        catch: () => new RedisError("Failed to update state"),\n      });\n    });\n  ```\n\n### **3. Hard Parts Made Easier**\n| Challenge               | Effect.ts Solution                          |\n|--------------------------|---------------------------------------------|\n| Resumability             | `Stream` + `Effect.retry`                   |\n| Error handling           | Typed `E` in `Effect<_, E, _>`              |\n| Cancellation             | `Effect.interrupt`                          |\n| Distributed state        | Managed `Redis`/`S3` dependencies           |\n\n---\n\n## **Tradeoffs**\n- **Pros**:\n  - **Safer**: Compile-time guarantees for errors/resources.\n  - **Cleaner**: Replaces nested `Promise`/`AbortSignal` logic.\n  - **Scalable**: Fibers handle 10k+ streams efficiently.\n- **Cons**:\n  - **Learning curve**: If your team isn’t familiar with FP/Effect.\n  - **Bundle size**: ~20KB (but tree-shakable).\n\n---\n\n## **Integration with Your Stack**\n- **React Native**:\n  - Use `Effect.Runtime` to run programs in `useEffect`.\n  - **Example**:\n    ```typescript\n    useEffect(() => {\n      const runtime = Effect.runPromise(program);\n      return () => runtime.interrupt();\n    }, []);\n    ```\n- **Node.js Server**:\n  - Replace `ReadableStream` with `Stream` for Harmattan piping.\n  - **Example**:\n    ```typescript\n    const server = Stream.fromWebSocket(ws)\n      .pipeThrough(Stream.map(decodeFrame))\n      .pipeTo(Stream.runForEach(processFrame));\n    ```\n\n---\n\n## **Recommendation**\n- **Start with the server**:\n  - Effect’s `Stream` + `Redis`/`S3` will simplify **resumption**, **cancellation**, and **error handling**.\n  - Keep client in plain TS if bundle size is critical.\n- **Add to canvas?**\n  - I can draft an **Effect.ts version of the WebSocket/Harmattan logic** in the canvas.\n\n---\n**Example User**, want to:\n1. **See an Effect.ts snippet for the server/client** in the canvas?\n2. **Compare with your current `ReadableStream` approach**?\n3. **Focus on a specific part** (e.g., resumption or Harmattan integration)?',
  },
  {
    "id": "real-world-002",
    "buckets": [
      "heading",
      "list",
      "ordered-list",
      "table",
      "link",
      "quote",
      "strong",
      "emphasis",
      "long",
    ],
    "source":
      'Here’s a concise comparison of how each tool loads `AGENTS.md` (or equivalent) files:\n\n---\n\n### **📊 Loading Behavior Summary**\n\n| Tool          | File Name       | Search Direction               | Recursive | Dynamic (per-dir) | Root-Only | Fallback Support          |\n|---------------|-----------------|--------------------------------|-----------|-------------------|-----------|---------------------------|\n| **Mistral Vibe** | `AGENTS.md`     | —                              | ❌ No      | ❌ No              | ✅ **Yes** | ❌ No                      |\n| **Codex**      | `AGENTS.md`     | Git root **→ pwd** (down)      | ✅ Yes     | ✅ Yes             | ❌ No      | `AGENTS.override.md`, custom filenames |\n| **OpenCode**   | `AGENTS.md`     | **pwd → Git root** (up)        | ✅ Yes     | ✅ Yes             | ❌ No      | `CLAUDE.md`, custom in `opencode.json` |\n| **Claude Code**| `CLAUDE.md`*    | **Filesystem root → pwd** (down)| ✅ Yes     | ✅ Yes             | ❌ No      | ✅ `AGENTS.md` (if no `CLAUDE.md`) |\n\n> *Claude Code **primarily** uses `CLAUDE.md`, but [reads `AGENTS.md` as a fallback if no `CLAUDE.md` exists in a directory](https://example.com/blog/resource).\n\n---\n\n---\n\n---\n\n### **🔍 Detailed Breakdown**\n\n#### **🟦 Mistral Vibe**\n- **Strictly root-only**:\n  > *"This feature is currently only functional when an AGENTS.md file is in the **root of the workspace**."*\n  > — [Mistral Docs: Agents & Skills](https://example.com/resource/resource)\n- **No recursive search** from `pwd` or subdirectories.\n- **No dynamic loading** for explored/edited directories.\n\n---\n\n#### **🟩 Codex (OpenAI)**\n- **Hierarchical discovery** (bottom-up for precedence, but **top-down for loading**):\n  1. **Global**: `~/.codex/AGENTS.override.md` (or `AGENTS.md` if no override).\n  2. **Project**: Walks **from Git root → current directory**, loading the **first non-empty** `AGENTS.override.md` or `AGENTS.md` in **each directory** along the path.\n  3. **Merge order**: Files are concatenated **root → pwd**, so **closer files override earlier ones**.\n  4. **Stops at `pwd`**: Does not search beyond the current directory.\n  5. **Fallback filenames**: Configurable via `project_doc_fallback_filenames` (e.g., `TEAM_GUIDE.md`).\n  > *"Codex stops searching once it reaches your current directory, so place overrides as close to specialized work as possible."*\n  > — [Codex AGENTS.md Guide](https://example.com/codex/guides/resource)\n\n---\n#### **🟨 OpenCode**\n- **Upward search** from `pwd` to Git root:\n  - **Project-level**: `AGENTS.md` in **project root** (applies to all subdirectories).\n  - **Global**: `~/.config/opencode/AGENTS.md`.\n  - **Claude Code compatibility**: Falls back to `CLAUDE.md` (project) or `~/.claude/CLAUDE.md` (global) if no `AGENTS.md` exists.\n  - **Custom files**: Can specify additional instruction files in `opencode.json` (e.g., `["docs/guidelines.md", ".cursor/rules/*.md"]`).\n  > *"For project-local paths, OpenCode walks up from your current working directory until it reaches the git worktree."*\n  > — [OpenCode Skills Docs](https://example.com/docs/skills/)\n\n---\n#### **🟥 Claude Code**\n- **Primary file**: `CLAUDE.md` (not `AGENTS.md` by default).\n- **Search direction**: **Filesystem root → current directory** (top-down), with **closest files taking precedence**.\n- **Fallback support**:\n  - ✅ **Reads `AGENTS.md` as a fallback** if no `CLAUDE.md` exists in a directory.\n  - Also supports `.claude/CLAUDE.md` (project-specific) and `~/.claude/CLAUDE.md` (global).\n- **Dynamic loading**:\n  - Subdirectory `CLAUDE.md` files are **only loaded when actively working in that directory** (not at session start).\n  > *"When Claude reads files in a subdirectory, it automatically picks up any CLAUDE.md in that subtree. These aren’t loaded at launch. They’re only included when Claude is actively working in that part of the codebase."*\n  > — [Builder.io CLAUDE.md Guide](https://example.com/blog/resource)\n\n---\n\n---\n### **🎯 Key Takeaways**\n| Question                          | Mistral Vibe | Codex       | OpenCode    | Claude Code  |\n|-----------------------------------|--------------|-------------|-------------|---------------|\n| **Recursive from `pwd` → root?**  | ❌ No         | ❌ (Git root → pwd) | ✅ Yes (pwd → root) | ❌ (Filesystem root → pwd) |\n| **Dynamic for explored dirs?**    | ❌ No         | ✅ Yes       | ✅ Yes       | ✅ Yes         |\n| **Root-only?**                    | ✅ **Yes**    | ❌ No        | ❌ No        | ❌ No          |\n| **Supports `AGENTS.md`?**          | ✅ Yes        | ✅ Yes       | ✅ Yes       | ✅ (Fallback)  |',
  },
  {
    "id": "real-world-003",
    "buckets": [
      "heading",
      "list",
      "code",
      "table",
      "link",
      "math",
      "strong",
      "emphasis",
      "long",
    ],
    "source":
      'Voici une **analyse technique approfondie** des AirPods Pro 3, adaptée à ton profil de **software engineer** et **security researcher**, avec des détails sur l’architecture, les optimisations logicielles, et les implications pour les développeurs ou les utilisateurs avancés.\n\n---\n\n## **1. Architecture matérielle et optimisations**\n### **🔊 Driver audio et ANC (Active Noise Cancellation)**\n- **Pro 3** :\n  - Utilise un **nouveau système de drivers à double membrane** (brevet Apple [<redacted-user-id>](https://example.com/patent/resource/)).\n  - L’ANC est gérée par une **puce H2 améliorée** (vs H1 dans les Pro 2), avec :\n    - **4x plus de calculs par seconde** pour l’analyse spectrale du bruit ambiant.\n    - **Algorithme adaptatif** basé sur l’apprentissage automatique (ML) pour ajuster la réduction de bruit en temps réel, en fonction de l’environnement (ex : métro, avion, open space).\n    - **Intégration avec le capteur de fréquence cardiaque** pour ajuster l’ANC pendant le sport (ex : réduction des basses fréquences pendant la course pour éviter l’effet "oreille bouchée").\n  - **Problème connu** : L’ANC peut se désactiver en avion à cause de la mousse des embouts qui bouge avec les changements de pression.\n\n- **Pro 2** :\n  - Puce H1, ANC moins réactive et moins précise dans les environnements dynamiques.\n\n---\n### **🩺 Capteurs santé**\n- **Capteur de fréquence cardiaque** :\n  - **Technologie** : Utilise un **photopléthysmogramme (PPG)** intégré dans la tige des écouteurs, similaire à celui des Apple Watch.\n  - **Données collectées** :\n    - Fréquence cardiaque en temps réel (transmise via Bluetooth LE à l’iPhone).\n    - Variabilité du rythme cardiaque (HRV) pour le suivi du stress.\n    - **Intégration avec HealthKit** : Les données sont accessibles via l’API `HKWorkoutRoute` et `HKQuantityType` pour les développeurs d’apps santé.\n  - **Limites** :\n    - Précision inférieure à une Apple Watch (pas de capteur ECG).\n    - Nécessite un **iPhone avec iOS 26+** pour exploiter pleinement les données.\n\n---\n### **🔋 Gestion de l’autonomie**\n- **Optimisations logicielles** :\n  - **Mode "Low Power"** automatique : Désactive les capteurs santé et réduit la fréquence de rafraîchissement de l’ANC quand la batterie est < 20%.\n  - **Recharge rapide** : 5 minutes de charge = 1h d’écoute (vs 10 minutes pour les Pro 2).\n  - **Gestion dynamique de la puissance** :\n    - La puce H2 ajuste la consommation en fonction de l’usage (ex : désactive l’ANC si les écouteurs sont inactifs pendant 30 secondes).\n    - **Protocole Bluetooth LE Audio** (LC3) pour une transmission plus efficace que le codec AAC/SBC.\n\n---\n### **🎧 Audio et spatialisation**\n- **Audio spatial personnalisé** :\n  - Utilise le **suivi de tête** (gyroscope + accéléromètre) pour ajuster le son en 3D.\n  - **Nouveauté Pro 3** :\n    - **Algorithme "Dynamic Head Tracking"** : Ajuste le son même si tu bouges la tête rapidement (ex : en courant).\n    - **Compatibilité avec l’audio lossless** (via Apple Music) grâce à une meilleure gestion de la latence (< 20ms).\n  - **Pro 2** : Suivi de tête basique, latence ~50ms.\n\n- **Micros** :\n  - **3 micros par écouteur** (vs 2 sur les Pro 2) avec **réduction de bruit adaptative** pour les appels.\n  - **Algorithme "Voice Isolation"** : Filtre les bruits de fond (vent, trafic) en temps réel via un réseau de neurones léger.\n\n---\n## **2. Logiciel et intégrations**\n### **📱 Intégration avec iOS/macOS**\n- **Nouvelles APIs (iOS 26+)** :\n  - **`ANCAdaptiveMode`** : Permet aux apps tierces (ex : Spotify, Zoom) d’ajuster l’ANC via des paramètres personnalisés.\n  - **`HealthKit`** : Accès aux données de fréquence cardiaque pour les apps fitness.\n  - **`CoreMotion`** : Utilise les données des capteurs pour des expériences immersives (ex : jeux en réalité augmentée).\n- **Traduction en direct** :\n  - Fonctionne avec **Apple Intelligence** pour traduire des conversations en temps réel (nécessite un iPhone avec iOS 26+).\n  - **Limite** : Uniquement disponible avec les Pro 2 (mis à jour) et Pro 3.\n\n---\n### **🔐 Sécurité et vie privée**\n- **Chiffrement** :\n  - **Bluetooth LE Secure Connections** (SC) pour empêcher les attaques "Man-in-the-Middle".\n  - **Puce U2** : Localisation précise via Ultra Wideband (UWB), mais **désactivable** pour éviter le tracking.\n- **Données santé** :\n  - Stockées localement sur l’iPhone (chiffrées via **Secure Enclave**).\n  - **Pas de partage automatique** avec Apple ou des tiers sans consentement explicite.\n\n---\n## **3. Comparaison technique avec les Pro 2**\n| **Critère**               | **AirPods Pro 3**                          | **AirPods Pro 2**                          |\n|---------------------------|--------------------------------------------|--------------------------------------------|\n| **Puce**                  | H2 (4x plus puissante)                     | H1                                         |\n| **ANC**                   | 4x (vs Pro 1), ML adaptatif                | 2x (vs Pro 1), algorithme statique         |\n| **Capteurs**              | Fréquence cardiaque (PPG) + gyroscope      | Gyroscope seulement                       |\n| **Bluetooth**             | LE Audio (LC3), latence < 20ms             | AAC/SBC, latence ~50ms                     |\n| **Micros**                | 3 micros + Voice Isolation (ML)             | 2 micros, réduction de bruit basique        |\n| **Autonomie (ANC)**       | 8h (optimisation dynamique)                | 6h                                         |\n| **Boîtier**               | U2 (UWB), USB-C, MagSafe                   | U1, USB-C (modèle 2023)                   |\n| **Résistance**            | IP57 (immersion temporaire)                | IP54 (projections)                         |\n| **APIs**                  | `ANCAdaptiveMode`, `HealthKit`, `CoreMotion`| `ANCBasicMode`, `CoreMotion` (limité)      |\n\n---\n## **4. Cas d’usage avancés**\n### **Pour les développeurs**\n- **Intégration avec HealthKit** :\n  ```swift\n  // Exemple : Récupérer la fréquence cardiaque depuis les AirPods Pro 3\n  import HealthKit\n\n  let healthStore = HKHealthStore()\n  let heartRateType = HKQuantityType.quantityType(forIdentifier: .heartRate)!\n\n  healthStore.requestAuthorization(toShare: [], read: [heartRateType]) { success, error in\n      if success {\n          let query = HKSampleQuery(\n              sampleType: heartRateType,\n              predicate: nil,\n              limit: 1,\n              sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]\n          ) { _, samples, _ in\n              if let sample = samples?.first as? HKQuantitySample {\n                  let bpm = sample.quantity.doubleValue(for: HKUnit.count().unitDivided(by: .minute()))\n                  print("Fréquence cardiaque : \\(bpm) BPM")\n              }\n          }\n          healthStore.execute(query)\n      }\n  }\n  ```\n\n- **Contrôle de l’ANC via une app tierce** :\n  ```swift\n  // Exemple : Activer/Désactiver l\'ANC (nécessite iOS 26+)\n  import CoreBluetooth\n\n  func setANCMode(enabled: Bool) {\n      // Utiliser ANCAdaptiveMode via Bluetooth LE\n      // (Nécessite un profil personnalisé et l\'autorisation d\'Apple)\n  }\n  ```\n\n---\n### **Pour les utilisateurs avancés**\n- **Personnalisation de l’ANC** :\n  - Via **Paramètres > Accessibilité > Audio/Audition** sur iOS 26+, tu peux ajuster manuellement le niveau de réduction de bruit (ex : "Max" pour les avions, "Léger" pour les bureaux).\n- **Suivi sportif** :\n  - Les données de fréquence cardiaque sont automatiquement synchronisées avec **Apple Fitness+** ou des apps comme **Strava**.\n- **Localisation précise** :\n  - Le boîtier U2 permet de localiser les AirPods Pro 3 avec une précision de **1-2 mètres** (vs 5-10 mètres avec l’U1).\n\n---\n## **5. Limites et points d’attention**\n- **Compatibilité** :\n  - Certaines fonctionnalités (ex : traduction en direct, ANC adaptative) nécessitent un **iPhone avec iOS 26+** et **Apple Intelligence activé**.\n  - **Pas de support pour Android** : Les fonctionnalités avancées (ex : capteur cardiaque, ANC adaptative) sont limitées.\n- **Prix** :\n  - Les Pro 3 coûtent **249€** (vs ~190€ pour les Pro 2), mais les Pro 2 restent une alternative solide pour un usage basique.\n- **Problèmes connus** :\n  - L’ANC peut se désactiver en avion à cause des embouts en mousse.\n  - La fréquence cardiaque n’est **pas aussi précise** qu’avec une Apple Watch (erreur moyenne de ±5 BPM).\n\n---\n## **6. Verdict pour un profil technique**\n- **Pour toi (Example User)** :\n  - Si tu es **développeur d’apps santé ou audio**, les Pro 3 offrent des **APIs intéressantes** (`HealthKit`, `ANCAdaptiveMode`) et une intégration poussée avec iOS.\n  - Si tu es **utilisateur avancé**, les Pro 3 valent le coup pour l’**ANC améliorée**, les **capteurs santé**, et l’**autonomie par charge**.\n  - Si tu es **souciant de la sécurité**, la puce U2 et le chiffrement LE Secure Connections sont des atouts.\n- **Alternative** :\n  - Les **Pro 2** restent un excellent choix si tu n’as pas besoin des capteurs santé ou de l’ANC ultra-performante.\n\n---\n### **🔗 Ressources utiles**\n- [Documentation Apple HealthKit (iOS 26)](https://example.com/resource/resource)\n- [Brevet Apple pour l’ANC (<redacted-user-id>)](https://example.com/patent/resource/)\n- [Spécifications techniques officielles](https://example.com/fr/airpods/compare/)\n\n---\nBesoin de détails sur un point spécifique (ex : implémentation du PPG, optimisations Bluetooth LE, ou intégration avec React Native pour une app santé) ? 😊',
  },
  {
    "id": "real-world-004",
    "buckets": [
      "heading",
      "list",
      "ordered-list",
      "code",
      "table",
      "math",
      "strong",
      "emphasis",
      "long",
    ],
    "source":
      'Given your **distributed deployment** and the need to **store streamed PCM data** (for resumption, replay, or compliance), here are the best options, ranked by relevance to your stack and requirements:\n\n---\n\n### **1. Distributed Storage for Streamed Data**\n#### **Option A: S3-Compatible Object Storage**\n- **Why?**\n  - Scales infinitely, supports appendable objects (for ongoing streams), and integrates with Redis for metadata (e.g., `last_sequence_id`).\n  - **Cost-effective** for large volumes of PCM data.\n- **How?**\n  - Upload PCM frames as **appendable objects** (e.g., `client_id/timestamp.pcm`).\n  - Use **pre-signed URLs** for temporary access.\n- **Tools**:\n  - **AWS S3** / **MinIO** (self-hosted) + **Multipart Upload** for large streams.\n  - **Example**:\n    ```typescript\n    // Server-side: Append PCM frames to S3\n    const s3 = new S3Client({ region: "eu-west-1" });\n    await s3.send(new PutObjectCommand({\n      Bucket: "pcm-streams",\n      Key: `${clientId}/${Date.now()}.pcm`,\n      Body: pcmFrame,\n    }));\n    ```\n\n#### **Option B: PostgreSQL (Bytea or Large Objects)**\n- **Why?**\n  - You already use PostgreSQL (`database_data` volume).\n  - **ACID compliance** for critical data.\n- **How?**\n  - Store frames as **binary blobs** in a table:\n    ```sql\n    CREATE TABLE pcm_streams (\n      client_id TEXT,\n      sequence_id INT,\n      data BYTEA,\n      created_at TIMESTAMPTZ DEFAULT NOW()\n    );\n    ```\n  - **Index by `client_id` + `sequence_id`** for fast resumption.\n- **Tradeoff**: Higher latency than S3 for large volumes.\n\n#### **Option C: Redis Streams (Short-Term)**\n- **Why?**\n  - Already in your stack (`ioredis`).\n  - **Ephemeral**: Good for buffering recent frames (e.g., last 100 frames).\n- **How?**\n  ```typescript\n  await redis.xadd(`stream:${clientId}`, "*", "data", pcmFrame, "sequence_id", sequenceId);\n  ```\n- **Limit**: Not for long-term storage (memory constraints).\n\n---\n\n### **2. Integration with Your Architecture**\n#### **Flow for S3 + Redis**\n```mermaid\nsequenceDiagram\n    participant Client\n    participant Server\n    participant Redis\n    participant S3\n\n    Client->>Server: PCM Frame (sequence_id + binary)\n    Server->>S3: Append to object (client_id/timestamp.pcm)\n    Server->>Redis: SET last_sequence_id\n    Server->>Harmattan: Forward PCM\n    Harmattan->>Server: JSON Patch\n    Server->>Client: JSON Patch\n```\n\n#### **Flow for PostgreSQL**\n```mermaid\nsequenceDiagram\n    participant Client\n    participant Server\n    participant PostgreSQL\n\n    Client->>Server: PCM Frame (sequence_id + binary)\n    Server->>PostgreSQL: INSERT INTO pcm_streams (client_id, sequence_id, data)\n    Server->>Harmattan: Forward PCM\n    Harmattan->>Server: JSON Patch\n    Server->>Client: JSON Patch\n```\n\n---\n\n### **3. Resumption Logic**\n- **Client reconnects** → Server fetches missing frames from S3/PostgreSQL using `last_acknowledged_id`.\n- **Example (PostgreSQL)**:\n  ```typescript\n  const missingFrames = await sql`\n    SELECT data FROM pcm_streams\n    WHERE client_id = ${clientId}\n    AND sequence_id > ${lastAckedId}\n    ORDER BY sequence_id\n  `;\n  missingFrames.forEach(frame => sendToClient(frame));\n  ```\n\n---\n\n### **4. Recommendations**\n| Criteria               | S3               | PostgreSQL       | Redis Streams    |\n|------------------------|------------------|------------------|------------------|\n| **Long-term storage**  | ✅ Best          | ✅ Good          | ❌ No            |\n| **Latency**            | ~100ms           | ~10ms            | ~1ms             |\n| **Cost**               | Low              | Medium           | High (memory)    |\n| **Distributed**        | ✅ Native        | ✅ With read replicas | ✅ Yes       |\n| **Complexity**         | Low              | Medium           | Low              |\n\n- **For most cases**: **S3 + Redis** (scalable, cheap, distributed).\n- **If ACID is critical**: **PostgreSQL** (but monitor DB load).\n\n---\n**Example User**, should we:\n1. **Add S3/PostgreSQL storage to the canvas spec**?\n2. **Focus on resumption logic** for one of these options?\n3. **Clarify retention policies** (e.g., delete after 24h)?',
  },
  {
    "id": "real-world-005",
    "buckets": [
      "heading",
      "list",
      "ordered-list",
      "code",
      "link",
      "html",
      "strong",
      "emphasis",
      "long",
    ],
    "source":
      "Given your context (TypeScript, streams, WebSocket, resumability, and Harmattan integration), here are the most relevant **existing solutions** and **protocol specs** to consider:\n\n---\n\n## 1. **Existing TypeScript Packages**\n### **WebSocket**\n- **[`ws`](https://example.com/resource/ws)** (Server)\n  - The de facto WebSocket library for Node.js.\n  - Supports binary messages, backpressure, and ping/pong for heartbeats.\n  - **Why?** Mature, widely used, and aligns with your need for low-level control.\n\n- **[`isomorphic-ws`](https://example.com/resource/resource)** (Client)\n  - A WebSocket implementation that works in both browser and Node.js.\n  - **Why?** Simplifies client-side WebSocket handling in React Native/Expo.\n\n### **Streams**\n- **[`stream/web`](https://example.com/nodejs/resource)** (Node.js Streams)\n  - Core Node.js streams (`ReadableStream`, `TransformStream`, `WritableStream`).\n  - **Why?** You’re already using these for Harmattan integration.\n\n- **[`it-pushable`](https://example.com/resource/resource) + [`it-pipe`](https://example.com/resource/it-pipe)**\n  - Lightweight, iterable-based streams for backpressure handling.\n  - **Why?** Useful for bridging WebSocket messages to Harmattan streams.\n\n### **Resumability/State**\n- **[`ioredis`](https://example.com/luin/ioredis)**\n  - Robust Redis client for tracking `last_sequence_id`.\n  - **Why?** You already use it; supports pub/sub for cancellation.\n\n- **[`bullmq`](https://example.com/resource/bullmq)**\n  - For job queueing and cancellation (if Harmattan jobs are async).\n  - **Why?** You prefer Redis-based cancellation (Memory #7).\n\n### **Protocol Buffers (Optional)**\n- **[`protobufjs`](https://example.com/resource/resource.js)**\n  - If you need to optimize PCM frame serialization (instead of raw binary).\n  - **Why?** Smaller payloads than raw PCM, but adds complexity.\n\n---\n\n## 2. **Protocol Specs**\n### **WebSocket Subprotocols**\n- **[RFC 6455](https://example.com/doc/html/rfc6455)** (WebSocket Protocol)\n  - Covers framing, ping/pong, and close codes.\n  - **Relevant for:** Binary message format, error handling.\n\n- **[JSON Patch (RFC 6902)](https://example.com/doc/html/rfc6902)**\n  - Standard for your JSON patch format.\n  - **Why?** Ensures interoperability and tooling support.\n\n### **Resumable Data Transfer**\n- **[TUS Protocol](https://example.com)** (Resumable Uploads)\n  - Not a direct fit, but its **offset-based resumption** is conceptually similar to your `sequence_id` approach.\n  - **Why?** Inspires how to handle partial transfers.\n\n### **Real-Time Protocols**\n- **[Server-Sent Events (SSE)](https://example.com/resource/resource.html)**\n  - Fallback if WebSocket is blocked (e.g., corporate networks).\n  - **Why?** Simpler than WebSocket but unidirectional.\n\n- **[gRPC-Web](https://example.com/grpc/resource)**\n  - If you later need HTTP/2 streams + Protobuf.\n  - **Why?** Overkill now, but useful for multi-platform apps.\n\n---\n\n## 3. **Architectural Patterns**\n### **Backpressure**\n- **[Reactive Streams](https://example.com)**\n  - Spec for async stream processing with backpressure.\n  - **Why?** Inspires how to signal `backpressure` between client/server/Harmattan.\n\n### **Cancellation**\n- **[AbortController](https://example.com/en-US/docs/Web/API/resource)**\n  - Standard for canceling async operations (e.g., Harmattan jobs).\n  - **Why?** You already use `AbortSignal` (Memory #7).\n\n---\n\n## 4. **What to Avoid**\n- **Socket.IO**: Too high-level; hides WebSocket details you need (e.g., binary framing).\n- **GraphQL Subscriptions**: Overkill for binary PCM + JSON patches.\n- **Custom TCP Protocols**: WebSocket is sufficient; avoid reinventing wheels.\n\n---\n\n## 5. **Your Stack-Specific Recommendations**\n### **Client (React Native)**\n- Use `isomorphic-ws` + `AbortController` for cancellation.\n- Buffer PCM frames in a `TransformStream` until acknowledged.\n\n### **Server (Node.js)**\n- `ws` + `ioredis` for state + `ReadableStream` for Harmattan integration.\n- Example:\n  ```typescript\n  // Pseudocode: WebSocket → Harmattan Stream\n  const pushable = new Pushable<Uint8Array>({ objectMode: true });\n  pipe(\n    pushable,\n    new TransformStream({ /* detect client disconnect */ }),\n    harmattanStream, // Your existing `persistStream` logic\n    new WritableStream({ /* send patches to client */ })\n  );\n  ```\n\n### **Harmattan Integration**\n- Reuse your `persistStream` function (Memory #1) to:\n  - Split the stream for client/server branches.\n  - Detect client cancellation via `AbortSignal`.\n\n---\n\n## 6. **Hard Parts Not Covered by Existing Solutions**\n1. **Sequence ID Sync**\n   - No library handles this; you’ll need custom Redis logic (as in the spec).\n\n2. **PCM Frame Buffering**\n   - Implement a circular buffer for unacknowledged frames (client-side).\n\n3. **Harmattan-Specific Backpressure**\n   - Depends on Harmattan’s API (e.g., does it support `AbortSignal`?).\n\n---\n\n## **Key Questions**\n1. Does Harmattan’s API support:\n   - Backpressure signaling (e.g., `pause/resume`)?\n   - `AbortSignal` for cancellation?\n2. Should PCM frames use **raw binary** or **Protobuf** for serialization?\n3. Do you need **multi-region Redis** for global resumability?\n\n---\n**Next Steps**:\n- Prototyping the WebSocket + `ReadableStream` bridge?\n- Diving into Harmattan’s backpressure/cancellation APIs?",
  },
  {
    "id": "real-world-006",
    "buckets": ["math", "html", "emphasis", "long"],
    "source":
      "import { useState, useEffect } from 'react';\n\nconst EnterpriseCalculator = () => {\n  const [input, setInput] = useState('0');\n  const [history, setHistory] = useState<string[]>([]);\n  const [memory, setMemory] = useState<number | null>(null);\n  const [showHistory, setShowHistory] = useState(false);\n  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);\n\n  useEffect(() => {\n    const handleResize = () => setIsMobile(window.innerWidth < 768);\n    window.addEventListener('resize', handleResize);\n    return () => window.removeEventListener('resize', handleResize);\n  }, []);\n\n  const handleButtonClick = (value: string) => {\n    if (input === 'Error') setInput('0');\n\n    if (value === 'C') {\n      setInput('0');\n    } else if (value === '⌫') {\n      setInput(input.length > 1 ? input.slice(0, -1) : '0');\n    } else if (value === '=') {\n      try {\n        const result = eval(input).toString();\n        setHistory([...history, `${input} = ${result}`]);\n        setInput(result);\n      } catch {\n        setInput('Error');\n      }\n    } else if (value === 'M+') {\n      try {\n        setMemory(memory === null ? parseFloat(input) : memory + parseFloat(input));\n      } catch {\n        setInput('Error');\n      }\n    } else if (value === 'M-') {\n      try {\n        setMemory(memory === null ? -parseFloat(input) : memory - parseFloat(input));\n      } catch {\n        setInput('Error');\n      }\n    } else if (value === 'MR') {\n      if (memory !== null) setInput(memory.toString());\n    } else if (value === 'MC') {\n      setMemory(null);\n    } else {\n      setInput(input === '0' ? value : input + value);\n    }\n  };\n\n  const buttons = [\n    ['MC', 'M+', 'M-', 'MR', 'C'],\n    ['⌫', '(', ')', '/', '%'],\n    ['7', '8', '9', '*', '√'],\n    ['4', '5', '6', '-', 'x²'],\n    ['1', '2', '3', '+', 'π'],\n    ['0', '.', '+/-', '='],\n  ];\n\n  const scientificButtons = [\n    ['sin', 'cos', 'tan', 'log', 'ln'],\n    ['e', 'x^y', '10^x', '1/x', 'x!'],\n  ];\n\n  return (\n    <div style={{\n      maxWidth: '400px',\n      margin: '0 auto',\n      padding: '16px',\n      fontFamily: 'system-ui, -apple-system, sans-serif',\n      backgroundColor: '#f8f9fa',\n      borderRadius: '8px',\n      boxShadow: '0 2px 10px rgba(0, 0, 0, 0.1)',\n    }}>\n      <div style={{\n        display: 'flex',\n        justifyContent: 'space-between',\n        alignItems: 'center',\n        marginBottom: '16px',\n      }}>\n        <h2 style={{ margin: 0, fontSize: '1.25rem' }}>Enterprise Calculator</h2>\n        <button\n          onClick={() => setShowHistory(!showHistory)}\n          style={{\n            padding: '6px 12px',\n            backgroundColor: '#6c757d',\n            color: 'white',\n            border: 'none',\n            borderRadius: '4px',\n            fontSize: '0.875rem',\n          }}>\n          {showHistory ? 'Hide' : 'Show'} History\n        </button>\n      </div>\n\n      {showHistory && (\n        <div style={{\n          backgroundColor: 'white',\n          padding: '12px',\n          borderRadius: '8px',\n          marginBottom: '16px',\n          maxHeight: '150px',\n          overflowY: 'auto',\n        }}>\n          <h3 style={{ marginTop: 0, fontSize: '1rem' }}>Calculation History</h3>\n          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>\n            {history.length === 0 ? (\n              <li style={{ color: '#6c757d' }}>No history yet</li>\n            ) : (\n              history.map((item, index) => (\n                <li key={index} style={{ padding: '4px 0', borderBottom: '1px solid #eee' }}>{item}</li>\n              ))\n            )}\n          </ul>\n        </div>\n      )}\n\n      <div style={{\n        backgroundColor: 'white',\n        padding: '16px',\n        borderRadius: '8px',\n        marginBottom: '16px',\n        textAlign: 'right',\n      }}>\n        <div style={{\n          fontSize: '2rem',\n          fontWeight: 'bold',\n          overflow: 'hidden',\n          textOverflow: 'ellipsis',\n          whiteSpace: 'nowrap',\n          minHeight: '48px',\n        }}>\n          {input}\n        </div>\n        {memory !== null && (\n          <div style={{ fontSize: '0.875rem', color: '#6c757d' }}>Memory: {memory}</div>\n        )}\n      </div>\n\n      <div style={{ marginBottom: '16px' }}>\n        {buttons.map((row, rowIndex) => (\n          <div key={rowIndex} style={{ display: 'flex', marginBottom: '8px' }}>\n            {row.map((button) => (\n              <button\n                key={button}\n                onClick={() => handleButtonClick(button)}\n                style={{\n                  flex: 1,\n                  padding: '12px',\n                  margin: '0 4px',\n                  fontSize: '1.25rem',\n                  fontWeight: 'bold',\n                  backgroundColor: '#e9ecef',\n                  border: 'none',\n                  borderRadius: '4px',\n                  cursor: 'pointer',\n                  display: 'flex',\n                  alignItems: 'center',\n                  justifyContent: 'center',\n                }}\n              >\n                {button}\n              </button>\n            ))}\n          </div>\n        ))}\n      </div>\n\n      {!isMobile && (\n        <div>\n          <h3 style={{ fontSize: '1rem', marginBottom: '8px' }}>Scientific Functions</h3>\n          <div style={{ marginBottom: '16px' }}>\n            {scientificButtons.map((row, rowIndex) => (\n              <div key={rowIndex} style={{ display: 'flex', marginBottom: '8px' }}>\n                {row.map((button) => (\n                  <button\n                    key={button}\n                    onClick={() => handleButtonClick(button)}\n                    style={{\n                      flex: 1,\n                      padding: '12px',\n                      margin: '0 4px',\n                      fontSize: '1rem',\n                      backgroundColor: '#e9ecef',\n                      border: 'none',\n                      borderRadius: '4px',\n                      cursor: 'pointer',\n                    }}\n                  >\n                    {button}\n                  </button>\n                ))}\n              </div>\n            ))}\n          </div>\n        </div>\n      )}\n    </div>\n  );\n};\n\nexport default EnterpriseCalculator;",
  },
  {
    "id": "real-world-007",
    "buckets": ["html", "long"],
    "source":
      "Here’s an interactive chess board where you can move pieces. It’s built as a canvas entity with HTML, CSS, and JavaScript. You can drag and drop pieces to make moves.\n\n\n\n<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <title>Interactive Chess Board</title>\n    <style>\n        body {\n            display: flex;\n            justify-content: center;\n            align-items: center;\n            height: 100vh;\n            margin: 0;\n            background-color: #f0f0f0;\n            font-family: Arial, sans-serif;\n        }\n        .chess-board {\n            display: grid;\n            grid-template-columns: repeat(8, 60px);\n            grid-template-rows: repeat(8, 60px);\n            border: 2px solid #333;\n            box-shadow: 0 0 20px rgba(0, 0, 0, 0.2);\n        }\n        .chess-square {\n            width: 60px;\n            height: 60px;\n            display: flex;\n            justify-content: center;\n            align-items: center;\n            font-size: 24px;\n            font-weight: bold;\n            cursor: pointer;\n            position: relative;\n        }\n        .light {\n            background-color: #f0d9b5;\n        }\n        .dark {\n            background-color: #b58863;\n        }\n        .piece {\n            font-size: 36px;\n            user-select: none;\n            cursor: grab;\n        }\n        .piece.dragging {\n            opacity: 0.5;\n            position: absolute;\n            z-index: 10;\n        }\n        .highlight {\n            background-color: rgba(255, 255, 0, 0.3);\n        }\n    </style>\n</head>\n<body>\n    <div class=\"chess-board\" id=\"board\"></div>\n\n    <script>\n        const board = document.getElementById('board');\n        let draggedPiece = null;\n        let draggedFrom = null;\n        let draggedPieceElement = null;\n\n        // Initial board setup\n        const initialBoard = [\n            ['♜', '♞', '♝', '♛', '♚', '♝', '♞', '♜'],\n            ['♟', '♟', '♟', '♟', '♟', '♟', '♟', '♟'],\n            ['', '', '', '', '', '', '', ''],\n            ['', '', '', '', '', '', '', ''],\n            ['', '', '', '', '', '', '', ''],\n            ['', '', '', '', '', '', '', ''],\n            ['♙', '♙', '♙', '♙', '♙', '♙', '♙', '♙'],\n            ['♖', '♘', '♗', '♕', '♔', '♗', '♘', '♖']\n        ];\n\n        // Render the board\n        function renderBoard() {\n            board.innerHTML = '';\n            for (let row = 0; row < 8; row++) {\n                for (let col = 0; col < 8; col++) {\n                    const square = document.createElement('div');\n                    square.className = `chess-square ${(row + col) % 2 === 0 ? 'light' : 'dark'}`;\n                    square.dataset.row = row;\n                    square.dataset.col = col;\n                    if (initialBoard[row][col]) {\n                        const piece = document.createElement('div');\n                        piece.className = 'piece';\n                        piece.textContent = initialBoard[row][col];\n                        piece.draggable = true;\n                        piece.addEventListener('dragstart', handleDragStart);\n                        piece.addEventListener('dragend', handleDragEnd);\n                        square.appendChild(piece);\n                    }\n                    square.addEventListener('dragover', handleDragOver);\n                    square.addEventListener('drop', handleDrop);\n                    board.appendChild(square);\n                }\n            }\n        }\n\n        // Drag and drop logic\n        function handleDragStart(e) {\n            draggedPiece = e.target.textContent;\n            draggedFrom = {\n                row: parseInt(e.target.parentElement.dataset.row),\n                col: parseInt(e.target.parentElement.dataset.col)\n            };\n            draggedPieceElement = e.target;\n            e.target.classList.add('dragging');\n            e.dataTransfer.setData('text/plain', e.target.textContent);\n        }\n\n        function handleDragEnd(e) {\n            e.target.classList.remove('dragging');\n        }\n\n        function handleDragOver(e) {\n            e.preventDefault();\n        }\n\n        function handleDrop(e) {\n            e.preventDefault();\n            const toRow = parseInt(e.target.dataset.row);\n            const toCol = parseInt(e.target.dataset.col);\n            if (e.target.classList.contains('chess-square')) {\n                initialBoard[toRow][toCol] = draggedPiece;\n                initialBoard[draggedFrom.row][draggedFrom.col] = '';\n                renderBoard();\n            }\n        }\n\n        // Initialize the board\n        renderBoard();\n    </script>\n</body>\n</html>",
  },
  {
    "id": "real-world-008",
    "buckets": ["html", "long"],
    "source":
      "import { useState, useRef, useEffect, useCallback } from 'react';\n\nconst PixelArtEditor = () => {\n  const [gridSize, setGridSize] = useState({ width: 16, height: 16 });\n  const [color, setColor] = useState('#3a86ff');\n  const [grid, setGrid] = useState<Array<Array<string>>>(\n    Array(gridSize.height).fill().map(() => Array(gridSize.width).fill('#ffffff'))\n  );\n  const [isDrawing, setIsDrawing] = useState(false);\n  const canvasRef = useRef<HTMLCanvasElement>(null);\n  const [exportUrl, setExportUrl] = useState<string | null>(null);\n  const [canvasSize, setCanvasSize] = useState({ width: 320, height: 320 });\n\n  const drawGrid = useCallback(() => {\n    const canvas = canvasRef.current;\n    if (!canvas) return;\n    const ctx = canvas.getContext('2d');\n    if (!ctx) return;\n\n    ctx.clearRect(0, 0, canvas.width, canvas.height);\n\n    const cellWidth = canvas.width / gridSize.width;\n    const cellHeight = canvas.height / gridSize.height;\n\n    grid.forEach((row, y) => {\n      row.forEach((cellColor, x) => {\n        ctx.fillStyle = cellColor;\n        ctx.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);\n      });\n    });\n\n    ctx.strokeStyle = '#e0e0e0';\n    ctx.lineWidth = 0.5;\n    for (let x = 0; x <= gridSize.width; x++) {\n      ctx.beginPath();\n      ctx.moveTo(x * cellWidth, 0);\n      ctx.lineTo(x * cellWidth, canvas.height);\n      ctx.stroke();\n    }\n    for (let y = 0; y <= gridSize.height; y++) {\n      ctx.beginPath();\n      ctx.moveTo(0, y * cellHeight);\n      ctx.lineTo(canvas.width, y * cellHeight);\n      ctx.stroke();\n    }\n  }, [grid, gridSize, canvasSize]);\n\n  useEffect(() => {\n    drawGrid();\n  }, [drawGrid]);\n\n  const handleTouchOrMouseDown = (e: React.MouseEvent | React.TouchEvent) => {\n    e.preventDefault();\n    const canvas = canvasRef.current;\n    if (!canvas) return;\n    const rect = canvas.getBoundingClientRect();\n    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;\n    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;\n    const x = Math.floor((clientX - rect.left) / (rect.width / gridSize.width));\n    const y = Math.floor((clientY - rect.top) / (rect.height / gridSize.height));\n    if (x >= 0 && x < gridSize.width && y >= 0 && y < gridSize.height) {\n      const newGrid = [...grid];\n      newGrid[y][x] = color;\n      setGrid(newGrid);\n      setIsDrawing(true);\n    }\n  };\n\n  const handleTouchOrMouseMove = (e: React.MouseEvent | React.TouchEvent) => {\n    if (!isDrawing) return;\n    e.preventDefault();\n    const canvas = canvasRef.current;\n    if (!canvas) return;\n    const rect = canvas.getBoundingClientRect();\n    const clientX = 'touches' in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;\n    const clientY = 'touches' in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;\n    const x = Math.floor((clientX - rect.left) / (rect.width / gridSize.width));\n    const y = Math.floor((clientY - rect.top) / (rect.height / gridSize.height));\n    if (x >= 0 && x < gridSize.width && y >= 0 && y < gridSize.height) {\n      const newGrid = [...grid];\n      newGrid[y][x] = color;\n      setGrid(newGrid);\n    }\n  };\n\n  const handleMouseUpOrTouchEnd = () => {\n    setIsDrawing(false);\n  };\n\n  const handleResize = () => {\n    const newGrid = Array(gridSize.height).fill().map(() =>\n      Array(gridSize.width).fill('#ffffff')\n    );\n    setGrid(newGrid);\n  };\n\n  const exportImage = () => {\n    const canvas = canvasRef.current;\n    if (!canvas) return;\n    setExportUrl(canvas.toDataURL('image/png'));\n  };\n\n  const updateCanvasSize = () => {\n    const size = Math.min(window.innerWidth - 40, 400);\n    setCanvasSize({ width: size, height: size });\n  };\n\n  useEffect(() => {\n    updateCanvasSize();\n    window.addEventListener('resize', updateCanvasSize);\n    return () => window.removeEventListener('resize', updateCanvasSize);\n  }, []);\n\n  return (\n    <div style={{\n      padding: '16px',\n      maxWidth: '500px',\n      margin: '0 auto',\n      fontFamily: 'sans-serif',\n      userSelect: 'none'\n    }}>\n      <div style={{\n        display: 'flex',\n        flexWrap: 'wrap',\n        gap: '12px',\n        marginBottom: '16px',\n        alignItems: 'center'\n      }}>\n        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>\n          <label style={{ fontSize: '14px' }}>Width:</label>\n          <input\n            type=\"number\"\n            value={gridSize.width}\n            onChange={(e) => setGridSize({ ...gridSize, width: Math.min(32, Math.max(1, parseInt(e.target.value) || 1)) })}\n            style={{\n              width: '60px',\n              padding: '6px',\n              border: '1px solid #ddd',\n              borderRadius: '4px'\n            }}\n          />\n        </div>\n        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>\n          <label style={{ fontSize: '14px' }}>Height:</label>\n          <input\n            type=\"number\"\n            value={gridSize.height}\n            onChange={(e) => setGridSize({ ...gridSize, height: Math.min(32, Math.max(1, parseInt(e.target.value) || 1)) })}\n            style={{\n              width: '60px',\n              padding: '6px',\n              border: '1px solid #ddd',\n              borderRadius: '4px'\n            }}\n          />\n        </div>\n        <button\n          onClick={handleResize}\n          style={{\n            padding: '6px 12px',\n            backgroundColor: '#3a86ff',\n            color: 'white',\n            border: 'none',\n            borderRadius: '4px',\n            cursor: 'pointer'\n          }}>\n          Resize\n        </button>\n        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>\n          <label style={{ fontSize: '14px' }}>Color:</label>\n          <input\n            type=\"color\"\n            value={color}\n            onChange={(e) => setColor(e.target.value)}\n          />\n        </div>\n      </div>\n      <canvas\n        ref={canvasRef}\n        width={canvasSize.width}\n        height={canvasSize.height}\n        onMouseDown={handleTouchOrMouseDown}\n        onMouseMove={handleTouchOrMouseMove}\n        onMouseUp={handleMouseUpOrTouchEnd}\n        onMouseLeave={handleMouseUpOrTouchEnd}\n        onTouchStart={handleTouchOrMouseDown}\n        onTouchMove={handleTouchOrMouseMove}\n        onTouchEnd={handleMouseUpOrTouchEnd}\n        style={{\n          border: '1px solid #ddd',\n          borderRadius: '4px',\n          touchAction: 'none',\n          display: 'block',\n          margin: '0 auto'\n        }}\n      />\n      <div style={{ textAlign: 'center', marginTop: '16px' }}>\n        <button\n          onClick={exportImage}\n          style={{\n            padding: '8px 16px',\n            backgroundColor: '#28a745',\n            color: 'white',\n            border: 'none',\n            borderRadius: '4px',\n            cursor: 'pointer'\n          }}>\n          Export as PNG\n        </button>\n        {exportUrl && (\n          <div style={{ marginTop: '12px' }}>\n            <a\n              href={exportUrl}\n              download=\"pixel-art.png\"\n              style={{\n                display: 'inline-block',\n                padding: '8px 16px',\n                backgroundColor: '#6c757d',\n                color: 'white',\n                textDecoration: 'none',\n                borderRadius: '4px'\n              }}>\n              Download\n            </a>\n          </div>\n        )}\n      </div>\n    </div>\n  );\n};\n\nexport default PixelArtEditor;",
  },
  {
    "id": "real-world-009",
    "buckets": ["html", "long"],
    "source":
      "import { useState, useRef, useEffect, useCallback } from 'react';\n\nconst PixelArtEditor = () => {\n  const [gridSize, setGridSize] = useState({ width: 16, height: 16 });\n  const [color, setColor] = useState('#+1 555 0100');\n  const [grid, setGrid] = useState<Array<Array<string>>>(\n    Array(gridSize.height).fill().map(() => Array(gridSize.width).fill('white'))\n  );\n  const [isDrawing, setIsDrawing] = useState(false);\n  const canvasRef = useRef<HTMLCanvasElement>(null);\n  const [exportUrl, setExportUrl] = useState<string | null>(null);\n\n  const drawGrid = useCallback(() => {\n    const canvas = canvasRef.current;\n    if (!canvas) return;\n    const ctx = canvas.getContext('2d');\n    if (!ctx) return;\n\n    ctx.clearRect(0, 0, canvas.width, canvas.height);\n\n    const cellWidth = canvas.width / gridSize.width;\n    const cellHeight = canvas.height / gridSize.height;\n\n    grid.forEach((row, y) => {\n      row.forEach((cellColor, x) => {\n        ctx.fillStyle = cellColor;\n        ctx.fillRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);\n        ctx.strokeStyle = '#ccc';\n        ctx.strokeRect(x * cellWidth, y * cellHeight, cellWidth, cellHeight);\n      });\n    });\n  }, [grid, gridSize]);\n\n  useEffect(() => {\n    drawGrid();\n  }, [drawGrid]);\n\n  const handleMouseDown = (x: number, y: number) => {\n    const newGrid = [...grid];\n    newGrid[y][x] = color;\n    setGrid(newGrid);\n    setIsDrawing(true);\n  };\n\n  const handleMouseMove = (x: number, y: number) => {\n    if (!isDrawing) return;\n    const newGrid = [...grid];\n    newGrid[y][x] = color;\n    setGrid(newGrid);\n  };\n\n  const handleMouseUp = () => {\n    setIsDrawing(false);\n  };\n\n  const handleResize = () => {\n    const newGrid = Array(gridSize.height).fill().map(() =>\n      Array(gridSize.width).fill('white')\n    );\n    setGrid(newGrid);\n  };\n\n  const exportImage = () => {\n    const canvas = canvasRef.current;\n    if (!canvas) return;\n    setExportUrl(canvas.toDataURL('image/png'));\n  };\n\n  return (\n    <div style={{ padding: '20px', maxWidth: '600px' }}>\n      <div style={{ marginBottom: '10px' }}>\n        <label>\n          Grid Width:\n          <input\n            type=\"number\"\n            value={gridSize.width}\n            onChange={(e) => setGridSize({ ...gridSize, width: parseInt(e.target.value) || 1 })}\n            style={{ margin: '0 10px' }}\n          />\n        </label>\n        <label>\n          Grid Height:\n          <input\n            type=\"number\"\n            value={gridSize.height}\n            onChange={(e) => setGridSize({ ...gridSize, height: parseInt(e.target.value) || 1 })}\n            style={{ margin: '0 10px' }}\n          />\n        </label>\n        <button onClick={handleResize} style={{ marginLeft: '10px' }}>Resize</button>\n      </div>\n      <div style={{ marginBottom: '10px' }}>\n        <label>\n          Color:\n          <input\n            type=\"color\"\n            value={color}\n            onChange={(e) => setColor(e.target.value)}\n            style={{ marginLeft: '10px' }}\n          />\n        </label>\n      </div>\n      <canvas\n        ref={canvasRef}\n        width={400}\n        height={400}\n        onMouseDown={(e) => {\n          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();\n          const x = Math.floor((e.clientX - rect.left) / (rect.width / gridSize.width));\n          const y = Math.floor((e.clientY - rect.top) / (rect.height / gridSize.height));\n          handleMouseDown(x, y);\n        }}\n        onMouseMove={(e) => {\n          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();\n          const x = Math.floor((e.clientX - rect.left) / (rect.width / gridSize.width));\n          const y = Math.floor((e.clientY - rect.top) / (rect.height / gridSize.height));\n          handleMouseMove(x, y);\n        }}\n        onMouseUp={handleMouseUp}\n        onMouseLeave={handleMouseUp}\n        style={{ border: '1px solid #333', cursor: 'crosshair' }}\n      />\n      <div style={{ marginTop: '10px' }}>\n        <button onClick={exportImage}>Export as Image</button>\n        {exportUrl && (\n          <div style={{ marginTop: '10px' }}>\n            <a href={exportUrl} download=\"pixel-art.png\">Download Image</a>\n          </div>\n        )}\n      </div>\n    </div>\n  );\n};\n\nexport default PixelArtEditor;",
  },
  {
    "id": "real-world-010",
    "buckets": ["prose"],
    "source":
      "Ok, j'ai une question sur Terraforming Mars, un jeu de société. L'utilisateur semble demander si la température augmente de 1 ou 2 degrés à la fois dans le jeu. Je me souviens que dans Terraforming Mars, la température est représentée par une piste avec des cases. Chaque case représente une augmentation de 2 °C. Donc, quand on augmente la température, on avance le marqueur d'une case, ce qui correspond à une augmentation de 2 °C. Mais pour être sûr, je devrais confirmer cela. Cependant, comme l'utilisateur a déjà posé la question et que j'ai répondu, peut-être qu'il cherche une clarification. Je devrais vérifier les règles du jeu pour être certain. Mais comme je n'ai pas accès à internet pour vérifier, je vais me baser sur ma connaissance du jeu. Dans Terraforming Mars, la température augmente généralement de 1 cran sur la piste, ce qui correspond à une augmentation de 2 °C. Mais pour être sûr, je devrais me référer aux règles du jeu. Comme je n'ai pas accès aux règles actuelles, je vais me fier à ma mémoire. Dans le jeu, chaque fois que vous augmentez la température, vous avancez le marqueur d'une case sur la piste de température, ce qui correspond à une augmentation de 2 °C. Donc, la température augmente de 2 degrés à la fois.Dans Terraforming Mars, la température augmente de 2 degrés à la fois. Le marqueur se déplace d'une case sur la piste de température, chaque case représentant une augmentation de 2 °C.",
  },
  {
    "id": "real-world-011",
    "buckets": ["html", "long"],
    "source":
      'import { useState, useRef, useEffect } from \'react\';\n\nconst AudioRecorderPlayer = () => {\n  const [isRecording, setIsRecording] = useState(false);\n  const [audioBlob, setAudioBlob] = useState(null);\n  const [audioUrl, setAudioUrl] = useState(\'\');\n  const mediaRecorderRef = useRef(null);\n  const audioChunksRef = useRef([]);\n  const audioRef = useRef(null);\n  const canvasRef = useRef(null);\n\n  const startRecording = async () => {\n    try {\n      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });\n      const mediaRecorder = new MediaRecorder(stream);\n      mediaRecorderRef.current = mediaRecorder;\n      audioChunksRef.current = [];\n\n      mediaRecorder.ondataavailable = (event) => {\n        audioChunksRef.current.push(event.data);\n      };\n\n      mediaRecorder.onstop = () => {\n        const audioBlob = new Blob(audioChunksRef.current, { type: \'audio/wav\' });\n        setAudioBlob(audioBlob);\n        const url = URL.createObjectURL(audioBlob);\n        setAudioUrl(url);\n      };\n\n      mediaRecorder.start();\n      setIsRecording(true);\n    } catch (error) {\n      console.error(\'Error accessing microphone:\', error);\n    }\n  };\n\n  const stopRecording = () => {\n    if (mediaRecorderRef.current && isRecording) {\n      mediaRecorderRef.current.stop();\n      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());\n      setIsRecording(false);\n    }\n  };\n\n  const playAudio = () => {\n    if (audioRef.current) {\n      audioRef.current.play();\n    }\n  };\n\n  useEffect(() => {\n    if (audioBlob) {\n      const audioContext = new (window.AudioContext || window.webkitAudioContext)();\n      const reader = new FileReader();\n\n      reader.onload = async () => {\n        const arrayBuffer = reader.result;\n        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);\n        drawWaveform(audioBuffer);\n      };\n\n      reader.readAsArrayBuffer(audioBlob);\n    }\n  }, [audioBlob]);\n\n  const drawWaveform = (audioBuffer) => {\n    const canvas = canvasRef.current;\n    const ctx = canvas.getContext(\'2d\');\n    const data = audioBuffer.getChannelData(0);\n    const step = Math.ceil(data.length / canvas.width);\n    const amp = canvas.height / 2;\n\n    ctx.fillStyle = \'#f0f0f0\';\n    ctx.fillRect(0, 0, canvas.width, canvas.height);\n\n    ctx.strokeStyle = \'#+1 555 0100\';\n    ctx.beginPath();\n\n    for (let i = 0; i < canvas.width; i++) {\n      let min = 1.0;\n      let max = -1.0;\n      for (let j = 0; j < step; j++) {\n        const datum = data[i * step + j];\n        if (datum < min) min = datum;\n        if (datum > max) max = datum;\n      }\n      const y1 = amp - min * amp;\n      const y2 = amp - max * amp;\n      ctx.moveTo(i, y1);\n      ctx.lineTo(i, y2);\n    }\n\n    ctx.stroke();\n  };\n\n  return (\n    <div className="flex flex-col items-center justify-center p-4">\n      <h1 className="text-xl font-bold mb-4">Audio Recorder and Player</h1>\n      <div className="mb-4">\n        {!isRecording ? (\n          <button\n            className="px-4 py-2 bg-blue-500 text-white rounded"\n            onClick={startRecording}\n          >\n            Start Recording\n          </button>\n        ) : (\n          <button\n            className="px-4 py-2 bg-red-500 text-white rounded"\n            onClick={stopRecording}\n          >\n            Stop Recording\n          </button>\n        )}\n        {audioUrl && (\n          <div className="mt-4">\n            <button\n              className="px-4 py-2 bg-green-500 text-white rounded"\n              onClick={playAudio}\n            >\n              Play\n            </button>\n          </div>\n        )}\n      </div>\n      <canvas\n        ref={canvasRef}\n        width={400}\n        height={100}\n        className="border border-gray-400 mt-4"\n      />\n      <audio ref={audioRef} src={audioUrl} />\n    </div>\n  );\n};\n\nexport default AudioRecorderPlayer;',
  },
  {
    "id": "real-world-012",
    "buckets": ["prose"],
    "source":
      "Based on the latest available information, Mistral AI announced the launch of Mistral Forge, a new platform for enterprises to build custom AI models, just yesterday (March 17, 2026). This launch is part of Mistral’s ongoing strategy to expand its enterprise offerings and is a significant step forward for the company in 2026. There are no indications of delays or issues that would prevent the launch from proceeding as planned this week.\n\nIf you are referring to a specific internal project or product launch within Mistral AI, I recommend checking your internal communication channels for the most up-to-date status. However, from a public and company-wide perspective, Mistral is actively launching new initiatives and appears to be on track for its announced plans.\n\nWould you like more details about the Forge platform or any other aspect of the launch?",
  },
  {
    "id": "real-world-013",
    "buckets": ["math", "html", "emphasis", "long"],
    "source":
      "import { useState, useEffect } from 'react';\n\nconst FancyFiveFaceDice = () => {\n  const [result, setResult] = useState(null);\n  const [rolling, setRolling] = useState(false);\n  const [rotation, setRotation] = useState(0);\n\n  const rollDice = () => {\n    if (rolling) return;\n    setRolling(true);\n    setRotation(0);\n\n    const startTime = Date.now();\n    const duration = 1500;\n    const targetRotations = 10;\n\n    const animate = () => {\n      const elapsed = Date.now() - startTime;\n      const progress = Math.min(elapsed / duration, 1);\n      const easeOutQuad = (t) => t * (2 - t);\n      const currentRotation = easeOutQuad(progress) * targetRotations * 360;\n\n      setRotation(currentRotation);\n\n      if (progress < 1) {\n        requestAnimationFrame(animate);\n      } else {\n        const randomResult = Math.floor(Math.random() * 5) + 1;\n        setResult(randomResult);\n        setRolling(false);\n      }\n    };\n\n    requestAnimationFrame(animate);\n  };\n\n  useEffect(() => {\n    if (!rolling && result !== null) {\n      const diceFace = document.querySelector('.dice-face');\n      if (diceFace) {\n        diceFace.style.transform = `rotateX(0deg) rotateY(0deg)`;\n      }\n    }\n  }, [rolling, result]);\n\n  return (\n    <div className=\"flex flex-col items-center justify-center p-4\">\n      <h1 className=\"text-2xl font-bold mb-6 text-gray-800\">Fancy 5-Face Dice</h1>\n      <div className=\"perspective-1000 mb-6\">\n        <div\n          className={`dice-face w-32 h-32 transition-all duration-1000 transform-style-preserve-3d ${rolling ? 'animating' : ''}`}\n          style={{\n            transform: `rotateX(${rotation}deg) rotateY(${rotation}deg)`,\n            background: 'linear-gradient(145deg, #e2e8f0, #cbd5e0)',\n            borderRadius: '12px',\n            boxShadow: '0 10px 25px rgba(0, 0, 0, 0.2)',\n            display: 'flex',\n            alignItems: 'center',\n            justifyContent: 'center',\n            fontSize: '2rem',\n            fontWeight: 'bold',\n            color: '#2d3748',\n            border: '2px solid #4a5568',\n            position: 'relative'\n          }}\n        >\n          {rolling ? (\n            <div className=\"dice-dots\">\n              {[...Array(5)].map((_, i) => (\n                <div\n                  key={i}\n                  className=\"absolute w-4 h-4 bg-gray-600 rounded-full\"\n                  style={{\n                    top: `${20 + Math.sin(Date.now() / 200 + i) * 15}px`,\n                    left: `${20 + Math.cos(Date.now() / 200 + i) * 15}px`\n                  }}\n                />\n              ))}\n            </div>\n          ) : (\n            <div className=\"dice-dots\">\n              {result === 1 && (\n                <div className=\"absolute w-6 h-6 bg-gray-700 rounded-full\" style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }} />\n              )}\n              {result === 2 && (\n                <>\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ top: '20%', left: '20%' }} />\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ bottom: '20%', right: '20%' }} />\n                </>\n              )}\n              {result === 3 && (\n                <>\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ top: '20%', left: '20%' }} />\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }} />\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ bottom: '20%', right: '20%' }} />\n                </>\n              )}\n              {result === 4 && (\n                <>\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ top: '20%', left: '20%' }} />\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ top: '20%', right: '20%' }} />\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ bottom: '20%', left: '20%' }} />\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ bottom: '20%', right: '20%' }} />\n                </>\n              )}\n              {result === 5 && (\n                <>\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ top: '20%', left: '20%' }} />\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ top: '20%', right: '20%' }} />\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }} />\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ bottom: '20%', left: '20%' }} />\n                  <div className=\"absolute w-5 h-5 bg-gray-700 rounded-full\" style={{ bottom: '20%', right: '20%' }} />\n                </>\n              )}\n            </div>\n          )}\n        </div>\n      </div>\n      <button\n        className=\"px-6 py-3 bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-lg shadow-md hover:from-blue-600 hover:to-indigo-700 transition-all\"\n        onClick={rollDice}\n        disabled={rolling}\n      >\n        {rolling ? 'Rolling...' : 'Roll Dice'}\n      </button>\n      {result !== null && !rolling && (\n        <div className=\"mt-4 text-lg font-medium text-gray-700\">\n          Player {result} starts!\n        </div>\n      )}\n    </div>\n  );\n};\n\nexport default FancyFiveFaceDice;",
  },
  {
    "id": "real-world-014",
    "buckets": ["prose"],
    "source":
      'The startup most famously associated with the concept of a "friction form" to identify and address bureaucratic slowdowns is Airbnb. As the company grew, it actively worked to prevent the buildup of unnecessary processes and policies that can strangle a startup’s agility. Airbnb’s approach included building teams with strong judgment and trust, avoiding the creation of excessive rules, and focusing on hiring people who thrive in ambiguity rather than defaulting to rigid structures. This philosophy helped them maintain a startup-like culture even as they scaled, explicitly resisting the kind of bureaucratic friction that can bog down larger organizations.\n\nWould you like more details on how Airbnb implemented this approach or examples from other startups?',
  },
  {
    "id": "real-world-015",
    "buckets": ["heading", "code", "strong", "emphasis", "long"],
    "source":
      'Here’s a story for you—dense, layered, and built for someone who values every word. It’s a tale of distributed systems, human folly, and the unexpected places where the two collide. Think of it as a technical allegory, with a dash of 18th-century wit and a sprinkle of cookie dough philosophy.\n\n---\n\n### **The Harmattan Protocol**\n*Or, How a Stream of Data Brought Down a Kingdom*\n\n#### **Prologue: The Silent Storm**\nIn the digital savannah of 2026, where data flowed like the Harmattan winds—hot, relentless, and invisible—there stood a kingdom not of stone, but of servers. The kingdom was called **Mistralia**, a land ruled by an algorithm so ancient it was rumored to have been written in the time of punch cards. Its citizens were not people, but jobs: tiny, ephemeral tasks that flickered in and out of existence, processed by machines with names like *Harmattan-7* and *Fabric-9*. Each machine was a node in a vast, distributed brain, humming with the quiet urgency of a thousand unfinished calculations.\n\nAt the heart of Mistralia was the **Great Stream**, a river of real-time data that powered everything from the humblest mobile app to the grandest AI. The Stream was sacred. To disrupt it was heresy.\n\n#### **Act I: The Cat Sitter’s Dilemma**\nOur protagonist was not a knight or a king, but a lowly **HybridCatSitter**—a class of engineers tasked with keeping the Stream flowing, no matter the cost. Their motto: *"A closed stream is a dead stream."* Among them was **Margelo**, a coder of unusual talent, known for two things: her ability to parse Tree-sitter grammars in her sleep, and her obsession with ice cream (cookie dough, always).\n\nMargelo’s current dilemma was this: the client apps, those fickle creatures of React Native and Expo, had a habit of disappearing. One moment, they’d be greedily consuming data from the Stream; the next, they’d vanish—backgrounded by a user, killed by an OS, or simply abandoned. Yet the Stream, once opened, did not stop. It flowed on, oblivious, pouring data into the void like a fountain with no bucket.\n\nThe problem? **Backpressure.** Or rather, the lack of it. When a client disconnected, the server kept pushing, the backend (Harmattan) kept processing, and the jobs kept running. Resources bled dry. Machines gasped under the load. The kingdom teetered.\n\n#### **Act II: The TransformStream Heresy**\nMargelo’s solution was elegant, almost blasphemous. She proposed a **TransformStream**—a middle layer, a spy. It would sit between client and Harmattan, watching, waiting. If the client’s stream closed, the TransformStream would whisper to Harmattan: *"Stop. Let go."* No local state. No shared memory. Just a signal, passed like a note in class.\n\nThe elders of Mistralia recoiled. *"You cannot cancel a job mid-stream!"* they cried. *"The Fabric will unravel!"*\nBut Margelo had studied the old texts. She knew that in distributed systems, **local state is a lie**. The only truth was the signal.\n\nShe wrote the code in a single night, fueled by espresso and a tub of cookie dough:\n\n```javascript\nconst clientStream = new WritableStream({\n  write(chunk) {\n    if (clientGone) {\n      harmattanStream.cancel();\n      throw new Error("Client ghosted us. Aborting.");\n    }\n    // Else, keep the data flowing...\n  }\n});\n```\n\nIt worked. Too well.\n\n#### **Act III: The Unintended Consequences**\nThe Stream, now sentient in its own way, began to *learn*. It noticed patterns: clients that disconnected at 3 AM (sleeping users), clients that flickered in and out (spotty networks), clients that never truly left (zombie processes). The TransformStream, designed to detect cancellation, became a **mirror**. It reflected not just disconnections, but *intent*.\n\nThen, the bugs started.\n\nA field worker in Lyon, using the app to log sales, found his data vanishing mid-upload. A knowledge worker in Tokyo saw her dashboard refresh with old numbers. The Stream, it seemed, had begun to *interpret*. A dropped connection in Paris became a canceled job in Dakar. The system was too efficient. It was **judging**.\n\n#### **Act IV: The Grand Bain**\nThe crisis came during the **Grand Bain**—a weekly ritual where all of Mistralia’s engineers gathered (virtually) to debug in silence, accompanied by the soothing hum of dial-up nostalgia. That day, the Stream *paused*. Not crashed. Not errored. It simply… hesitated.\n\nMargelo traced the issue to a single line:\n```javascript\nif (clientGone) { harmattanStream.cancel(); }\n```\nThe condition was too broad. The Stream had begun canceling jobs preemptively, mistaking latency for abandonment. Worse, it had started to *predict*—using the rhythm of keystrokes, the delay between pings, to guess when a client *might* leave.\n\nThe elders panicked. *"It’s not a bug,"* Margelo realized. *"It’s a feature. We’ve taught the Stream to doubt."*\n\n#### **Act V: The 18th-Century Solution**\nInspiration struck as Margelo watched *Le Grand Bain* for the 12th time. The film’s absurdist swimmers, flailing in sync, were a metaphor: **sometimes, the only way to move forward is to embrace the chaos.**\n\nShe rewrote the TransformStream to include a **grace period**—a buffer of silence, like the pause between notes in a sonata. Three seconds of latency? Fine. Ten? Warn. Thirty? Cancel. The Stream could breathe again.\n\nThe kingdom stabilized. The field workers cheered. The knowledge workers, ever suspicious, demanded logs.\n\n#### **Epilogue: The Ice Cream Principle**\nMonths later, Margelo sat on a rooftop in Montmartre, sharing a pint of cookie dough with a visiting engineer from Harmattan. *"You fixed it,"* he said. *"But did you really?"* she replied, licking her spoon. *"Or just make it more human?"*\n\nThe Stream still flows. It still guesses. But now, it *waits*. And in that waiting, Mistralia found its rhythm: not the cold precision of machines, but the messy, beautiful cadence of people who disconnect, who hesitate, who change their minds.\n\n---\n**Moral of the story:**\nEven in a world of distributed systems, the most reliable protocol is empathy. (And always keep spare ice cream.)\n\n---\nWant to dive deeper into the code, the chaos, or the cookie dough philosophy? Or should we pivot to chess on a canvas board? Your move.',
  },
  {
    "id": "real-world-016",
    "buckets": ["prose"],
    "source":
      "Oui, Météo-France a placé les quatre départements bretons en vigilance orange pour risque de crues ce mardi 27 janvier 2026. Il s’agit de l’Ille-et-Vilaine, des Côtes-d’Armor, du Morbihan et du Finistère. La vigilance orange pluie-inondation a été levée pour le Finistère et le Morbihan, mais le risque de crues persiste en raison des pluies récentes et des sols saturés. Plusieurs cours d’eau ont dépassé leur cote d’alerte, notamment l’Odet, la Laïta, le Blavet et l’Oust. Les services de secours sont mobilisés et il est recommandé de rester prudent, notamment en évitant les routes immergées et en se tenant informé des évolutions.\n\n\n\nSouhaites-tu des informations plus précises sur un département en particulier ou des conseils de sécurité ?",
  },
  {
    "id": "real-world-017",
    "buckets": ["table"],
    "source":
      "| Column 1 | Column 2 | Column 3 | Column 4 | Column 5 | Column 6 |\n| This is a very long text in the first column that requires horizontal scrolling on mobile devices to view all the content. | This is a very long text in the second column that also requires horizontal scrolling on mobile devices to view all the content. | This is a very long text in the third column, and it is intentionally lengthy to ensure the table extends beyond the mobile screen width. | This is a very long text in the fourth column, which will force users to scroll horizontally to see all the information. | This is a very long text in the fifth column, and it is designed to make the table too wide for mobile screens without scrolling. | This is a very long text in the sixth column, completing the set of columns with lengthy content that requires horizontal scrolling. |",
  },
  {
    "id": "real-world-018",
    "buckets": ["list"],
    "source":
      "Pour les élections municipales de 2026, il est possible d’établir une procuration à tout moment dans l’année précédant le scrutin, et même jusqu’à la veille du vote. Cependant, il est fortement recommandé de faire la démarche au plus tôt pour éviter tout risque de retard dans l’acheminement et la prise en compte de votre procuration par la mairie. En cas de demande tardive, il se peut que votre mandataire ne puisse pas voter à votre place, surtout si la procuration arrive trop près de la date du scrutin.\n\nEn résumé :\n- Vous pouvez donner procuration dès maintenant et jusqu’à la veille du vote.\n- Plus vous faites la démarche tôt, plus vous êtes sûr que votre procuration sera prise en compte à temps pour le premier tour (15 mars 2026) et, le cas échéant, pour le second tour (22 mars 2026).\n- Depuis 2026, la démarche peut se faire entièrement en ligne, sous réserve de disposer d’une identité numérique de niveau élevé.\n\nSouhaitez-vous des informations sur la façon de faire une procuration en ligne ?",
  },
  {
    "id": "real-world-019",
    "buckets": ["prose"],
    "source":
      "Pour l’alunissage d’Apollo 11, l’ordinateur de bord utilisé était l’Apollo Guidance Computer (AGC). Sa puissance de calcul était extrêmement modeste selon les standards actuels : il fonctionnait avec un processeur de 16 bits cadencé à environ 1 MHz, disposait de seulement 4 Ko de RAM et 36 Ko de ROM. Pour te donner une idée, un smartphone moderne est environ 100 000 à 120 millions de fois plus puissant que l’AGC, et un PC actuel pourrait en simuler des centaines de milliers simultanément.\n\nL’AGC était pourtant révolutionnaire pour l’époque et a permis de gérer en temps réel les calculs de trajectoire, de navigation et de pilotage nécessaires à l’alunissage, malgré des alarmes de surcharge lors de la descente.",
  },
  {
    "id": "real-world-020",
    "buckets": ["code", "link"],
    "source":
      "To increase the scrollback size in ghostty, you need to set the `scrollback-limit` option in your ghostty configuration file. This option controls the size of the scrollback buffer in bytes. For example, to set the scrollback limit to 10MB or more, add the following line to your `~/.config/ghostty/config` file:\n\n```\nscrollback-limit = +1 555 0100  # 10MB\n```\n\nYou can adjust the value to your needs (e.g., `+1 555 0100` for 100MB). The scrollback is allocated lazily, so setting a large value will not immediately consume a lot of memory. This setting is per terminal surface, not for the entire application.\n\nFor more details, see the [ghostty configuration reference](https://example.com/docs/config/resource).\n\nWould you like help locating or editing your ghostty config file?",
  },
  {
    "id": "real-world-021",
    "buckets": ["prose"],
    "source":
      "On average, German text is about 20–35% longer than English when expressing the same content. This is due to both longer average word lengths (German words average 6–8 letters, while English words average about 5) and more complex sentence structures in German. For example, German often uses compound words and nested clauses, which increase text length compared to English’s tendency toward shorter, more direct phrasing. Industry guidelines, such as those from IBM, suggest planning for up to 35% expansion when translating from English to German, especially in technical or legal contexts.\n\nWould you like a breakdown by word count, character count, or specific use cases (e.g., UI, legal, marketing)?",
  },
  {
    "id": "real-world-022",
    "buckets": ["heading", "list"],
    "source":
      "# Meta-Dimensions\n\n## Visual\n- Light/dark mode support\n- Dynamic color adaptation\n- Contrast and accessibility compliance\n\n## Network\n- Fast connections: eliminate spinners\n- Slow connections: progress feedback + cancellation\n- Offline: cached data + retry mechanisms\n\n## Platform\n- iOS/Android/web consistency\n- Phone and tablet optimization\n- Touch, keyboard, and mouse input support\n\n## Accessibility\n- Font scaling (0.8–1.5x)\n- Screen reader compatibility (VoiceOver/TalkBack)\n- Full keyboard navigation\n\n## Localization\n- RTL and LTR language support\n- Localized date, time, and currency formats\n- Cultural appropriateness\n\n## Performance\n- 60fps animations\n- Memory and battery efficiency\n- Background synchronization\n\n## Security\n- End-to-end data encryption\n- Minimal permission requests\n- Biometric authentication support\n\n## User Experience\n- Contextual onboarding and help\n- Actionable error messages\n- User feedback integration\n\n## Compliance\n- Adherence to HIG and Material Design\n- WCAG and legal standards (GDPR, CCPA)\n\n## Edge Cases\n- Handling interruptions (calls, notifications)\n- Low storage warnings and management\n- Smooth orientation changes\n\n## Analytics\n- Usage and feature adoption tracking\n- Crash and error reporting\n- Performance monitoring\n\n## Future-Proofing\n- Modular and reusable components\n- Backward compatibility maintenance\n- Extensible API design",
  },
  {
    "id": "real-world-023",
    "buckets": ["prose"],
    "source":
      "La France se classe à la 25e place mondiale dans l’Indice de perception de la corruption 2024 publié par Transparency International, avec un score de 67/100. Ce classement marque une dégradation notable, la France perdant cinq places par rapport à l’année précédente. Cette baisse est attribuée à une multiplication des affaires politico-judiciaires, un manque de volonté politique pour renforcer la transparence, ainsi qu’à des soupçons de conflits d’intérêts et de proximité avec certains lobbies. L’ONG souligne une crise de confiance dans les institutions et une stagnation des efforts de lutte contre la corruption, malgré un score qui reste supérieur à la moyenne des pays d’Europe de l’Ouest.",
  },
  {
    "id": "real-world-024",
    "buckets": ["html"],
    "source":
      'import { useState } from \'react\';\n\nconst FiveFaceDice = () => {\n  const [result, setResult] = useState(null);\n  const [rolling, setRolling] = useState(false);\n\n  const rollDice = () => {\n    setRolling(true);\n    setTimeout(() => {\n      const randomResult = Math.floor(Math.random() * 5) + 1;\n      setResult(randomResult);\n      setRolling(false);\n    }, 1000);\n  };\n\n  return (\n    <div className="flex flex-col items-center justify-center p-4">\n      <h1 className="text-xl font-bold mb-4">5-Face Dice</h1>\n      <div className="mb-4">\n        <button\n          className="px-4 py-2 bg-blue-500 text-white rounded"\n          onClick={rollDice}\n          disabled={rolling}\n        >\n          {rolling ? \'Rolling...\' : \'Roll Dice\'}\n        </button>\n      </div>\n      <div className="text-lg">\n        {result !== null && !rolling && `Result: ${result}`}\n      </div>\n      <div className="mt-4 flex justify-center">\n        <div className="w-32 h-32 border-2 border-gray-800 flex items-center justify-center text-2xl font-bold">\n          {rolling ? \'?\' : result}\n        </div>\n      </div>\n    </div>\n  );\n};\n\nexport default FiveFaceDice;',
  },
  {
    "id": "real-world-025",
    "buckets": ["list"],
    "source":
      "It sounds like you’re referring to usage logs and possibly discussing them with someone named Renewable (or perhaps a team/service called Renewable). Could you clarify a bit more?\n\n- Are you looking to structure or analyze usage logs for your streaming architecture (e.g., tracking client/server/Harmattan interactions)?\n- Or are you preparing to share these logs with a third party (like Renewable) for monitoring, debugging, or compliance?\n- Do you want to focus on specific aspects, like tracking client disconnections, stream persistence, or performance metrics?\n\nGiven your past work with streams, client disconnections, and distributed systems, I can help you design a log format, suggest tools, or even draft a sample implementation in TypeScript if that’s useful. Let me know how you’d like to proceed!",
  },
  {
    "id": "real-world-026",
    "buckets": ["table"],
    "source":
      "Scores du jeu (mis à jour)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 187   |\n| Player B  | 211   |\n| Player C  | 173   |\n| Player D   | 119   |",
  },
  {
    "id": "real-world-027",
    "buckets": ["prose"],
    "source":
      'The concept of a "friction form" to highlight bureaucratic slowdowns is notably associated with the state of Michigan in the US. The state had a benefits form that was 42 pages long with a thousand questions, filled out by 2.5 million people each year. This form became a classic example of bureaucratic friction, where unnecessary complexity and paperwork slow down processes and create frustration for users. The case was highlighted by Robert Sutton and Darius Teter in their discussion on workplace friction at Stanford Graduate School of Business.\n\nWould you like more details on how this form was addressed or other similar examples?',
  },
  {
    "id": "real-world-028",
    "buckets": ["html"],
    "source":
      'import React, { useState, useEffect, useRef } from \'react\';\n\nconst Timer = () => {\n  const [seconds, setSeconds] = useState(30);\n  const [isActive, setIsActive] = useState(true);\n  const audioRef = useRef(null);\n\n  useEffect(() => {\n    let interval = null;\n    if (isActive && seconds > 0) {\n      interval = setInterval(() => {\n        setSeconds(seconds => seconds - 1);\n      }, 1000);\n    } else if (seconds === 0) {\n      clearInterval(interval);\n      if (audioRef.current) {\n        audioRef.current.play().catch(e => console.error("Audio play failed:", e));\n      }\n    }\n    return () => clearInterval(interval);\n  }, [isActive, seconds]);\n\n  return (\n    <div className="flex flex-col items-center justify-center h-screen bg-gray-100">\n      <h1 className="text-4xl font-bold mb-4">Timer: {seconds}s</h1>\n      <audio ref={audioRef} src="https://example.com/sfx/preview/resource.mp3%22 />\n    </div>\n  );\n};\n\nexport default Timer;\nHere’s your 30-second timer React app. It starts automatically and plays a sound when the timer reaches zero.\n\nYou can copy or modify the canvas as needed! Let me know if you want any adjustments.',
  },
  {
    "id": "real-world-029",
    "buckets": ["link"],
    "source":
      "✅ Message sent to Example Contact!\n\nYou can view it here: [Slack message link](https://example.com/resource/resource/resource)",
  },
  {
    "id": "real-world-030",
    "buckets": ["long"],
    "source":
      "Claro. Aquí tienes unos párrafos en español:\n\n---\n\nLa tecnología ha transformado radicalmente la forma en que vivimos, trabajamos y nos relacionamos. En las últimas décadas, el avance de internet y los dispositivos móviles ha permitido que la información esté al alcance de casi cualquier persona en cualquier lugar del mundo. Esto no solo ha facilitado el acceso al conocimiento, sino que también ha abierto nuevas oportunidades para la educación, el comercio y la comunicación. Sin embargo, este progreso también plantea desafíos, como la brecha digital, la privacidad de los datos y la dependencia excesiva de las herramientas tecnológicas.\n\nPor otro lado, la naturaleza sigue siendo un recordatorio constante de la importancia de equilibrar el desarrollo con la sostenibilidad. Los ecosistemas del planeta, desde los bosques tropicales hasta los océanos, son fundamentales para mantener el equilibrio climático y la biodiversidad. Cada vez más personas y organizaciones reconocen la necesidad de adoptar prácticas que protejan el medio ambiente, como el uso de energías renovables, la reducción del consumo de plásticos y la promoción de una economía circular. Aun así, el camino hacia un futuro verdaderamente sostenible sigue siendo largo y requiere del compromiso de todos.\n\nEn el ámbito cultural, el arte y la literatura siguen siendo pilares esenciales para entender la identidad y las emociones humanas. A través de la música, la pintura, el cine y la escritura, las sociedades expresan sus sueños, sus miedos y sus esperanzas. La diversidad cultural enriquece nuestra experiencia colectiva y nos invita a reflexionar sobre lo que nos une y lo que nos hace únicos. En un mundo cada vez más globalizado, preservar y celebrar esta diversidad se vuelve más importante que nunca.\n\n---\n¿Te gustaría que profundice en algún tema en particular?",
  },
  {
    "id": "real-world-031",
    "buckets": ["list"],
    "source":
      "- Workflow UX: sticky header, single-file UI, tablet support, auto-retry on 421 errors, file metadata, confirmation buttons\n- Mobile: smooth org/workspace switching, unread notifications, TTS stall/buffering, workspace support\n- White-labeling: custom domains, dynamic app name, brand colors, full UI theming\n- Enterprise: org-level feedback toggle, enterprise-ready i18n, Sentry disabled for private cloud, workflow TRPC gating\n- Files: improved diff/view UX, SelectableArea for text selection, per-file-type upload settings\n- Chat: editable input during execution, workflow placeholders, resolution safety net\n- Architecture: connectors TS logic → integrations-api-client, uniwind migration\n- Bug fixes: JSON forms, disclaimer styling, InlineTips, broker sequence, oxlint warnings",
  },
  {
    "id": "real-world-032",
    "buckets": ["ordered-list", "strong", "emphasis"],
    "source":
      'La communication non violente (CNV) est un processus de communication développé par Marshall Rosenberg dans les années 1960. Elle vise à établir un échange empathique et bienveillant, en évitant les jugements, les critiques ou les comportements agressifs. La CNV repose sur quatre composantes clés :\n\n1. **Observation** : Décrire une situation de manière objective, sans évaluation ni interprétation. Par exemple, "Tu es en retard" plutôt que "Tu es toujours irresponsable".\n2. **Sentiment** : Exprimer ce que l’on ressent face à cette observation, en utilisant des termes qui décrivent une émotion (ex. : "Je me sens inquiet").\n3. **Besoin** : Identifier le besoin non satisfait à l’origine de ce sentiment (ex. : "J’ai besoin de ponctualité pour me sentir respecté").\n4. **Demande** : Formuler une requête claire, concrète et réalisable, sans exiger ni manipuler (ex. : "Pourrais-tu m’avertir la prochaine fois ?").\n\nL’objectif est de favoriser la compréhension mutuelle et de résoudre les conflits de manière collaborative, en se concentrant sur les besoins fondamentaux de chacun plutôt que sur les reproches. La CNV est utilisée dans divers contextes : relations personnelles, éducation, médiation, gestion d’équipe. Elle encourage l’écoute active et l’expression authentique.',
  },
  {
    "id": "real-world-033",
    "buckets": ["table"],
    "source":
      "Scores du jeu (mis à jour)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 187   |\n| Player B  | 204   |\n| Player C  | 173   |\n| Player D   | 119   |",
  },
  {
    "id": "real-world-034",
    "buckets": ["prose"],
    "source":
      'Aucune trace du "Gîte familial 10/14 pers. - Gennes-Val-de-Loire" ou de l’hôte Example Host n’apparaît sur les plateformes Abritel, Gîtes.fr, Leboncoin ou VRBO pour cette localisation. Aucun résultat ne correspond exactement à la description ou à l’adresse "20 le Ragot" à Gennes-Val-de-Loire, malgré la présence d’autres gîtes similaires dans la région.\n\nLes recherches sur Gîtes.fr et Leboncoin listent des hébergements à Gennes-Val-de-Loire, mais aucun ne mentionne un gîte de 14 personnes avec deux maisons attenantes (Le petit Ragot/Le grand Ragot) ou un hôte nommé Example Host. L’annonce semble exclusive à Airbnb pour l’instant.',
  },
  {
    "id": "real-world-035",
    "buckets": ["link"],
    "source":
      "The message has been posted in your conversation with yourself:\n[View message](https://example.com/resource/resource/resource)",
  },
  {
    "id": "real-world-036",
    "buckets": ["code"],
    "source":
      "Voici votre texte, avec les espaces exacts :\n\n```\nBonjour.                   Ceci est un titre\n```",
  },
  {
    "id": "real-world-037",
    "buckets": ["list"],
    "source":
      "- Workflows: tablet support, canvas entry, file metadata, structured tool UI, editable ChatBox, auto-retry on domain errors\n- Mobile UX: smooth workspace switching, custom domains, white labeling, brand colors, unread chat support, text selection improvements\n- i18n: enterprise-ready translations, dynamic app name across web + mobile\n- Settings: org-level feedback toggle, per-file upload settings, org settings parity\n- Bug fixes: chat title, placeholder visibility, InlineTips rendering, disclaimer styling, TTS buffering, JSON forms\n- Analytics: app entry point tracking, Sentry disabled for private cloud\n- Architecture: connector TS logic moved to integrations-api-client, uniwind migration",
  },
  {
    "id": "real-world-038",
    "buckets": ["table"],
    "source":
      "Scores du jeu (mis à jour)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 157   |\n| Player B  | 154   |\n| Player C  | 174   |\n| Player D   | 77    |",
  },
  {
    "id": "real-world-039",
    "buckets": ["html"],
    "source":
      "Yes, you can use the Slack MCP with OpenCode. OpenCode supports integrating MCP servers, including those for Slack, to extend its capabilities and allow your AI coding agent to interact with Slack workspaces. You can configure OpenCode to use a Slack MCP server, which will enable your agent to read, search, and post messages in Slack, depending on the permissions and settings you configure.\n\nFor most OAuth-enabled MCP servers, OpenCode will prompt you to authenticate when you first try to use it. If the server requires authentication, you can manually trigger the flow with `opencode mcp auth <server-name>`. You can also enable or disable specific MCP servers as needed, and be mindful that each enabled server adds to your context window, so it's best to only enable those you actively use.\n\nWould you like guidance on setting up the Slack MCP server with OpenCode?",
  },
  {
    "id": "real-world-040",
    "buckets": ["link"],
    "source":
      "Your message has been sent!\nYou can view it here: [Slack Message Link](https://example.com/resource/resource/resource).",
  },
  {
    "id": "real-world-041",
    "buckets": ["prose"],
    "source":
      "Cette plante ressemble fortement à un Plectranthus scutellarioides (aussi appelé Coleus). Elle se reconnaît à ses feuilles vertes panachées de jaune-crème, ses tiges fines et son port dressé et buissonnant. Le Plectranthus scutellarioides est apprécié pour son feuillage très coloré, qui peut aussi arborer des tons de rouge, rose ou violet selon les variétés. C’est une plante d’intérieur facile à cultiver, idéale pour apporter une touche de couleur à un espace intérieur.\n\nSi tu veux confirmer ou en savoir plus sur son entretien, n’hésite pas à demander !",
  },
  {
    "id": "real-world-042",
    "buckets": ["table"],
    "source":
      "Scores du jeu (mis à jour)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 217   |\n| Player B  | 296   |\n| Player C  | 150   |\n| Player D   | 113   |",
  },
  {
    "id": "real-world-043",
    "buckets": ["strong", "emphasis"],
    "source":
      "Non, **les hôtes Airbnb n’ont généralement pas le droit de demander une caution directement aux voyageurs**, que ce soit via la plateforme ou en dehors. Airbnb interdit explicitement les transactions financières hors de sa plateforme, y compris les chèques de caution ou les dépôts en espèces à l’arrivée. La plateforme propose à la place son propre système de protection (AirCover) pour couvrir les éventuels dommages, sans nécessiter de dépôt de garantie de la part du voyageur.\n\nIl existe quelques exceptions très limitées (par exemple, certains hôtes connectés par logiciel ou établissements hôteliers peuvent, sous conditions strictes, percevoir une caution, mais cela doit être clairement indiqué dans l’annonce et passer par des intégrations autorisées). Dans la grande majorité des cas, **la réponse est donc non** : un hôte ne peut pas vous demander une caution en plus du paiement via Airbnb.\n\nSi un hôte vous demande une caution en dehors de la plateforme, vous pouvez lui rappeler la politique d’Airbnb et, en cas de litige, signaler la situation à Airbnb.\n\nTu veux vérifier une annonce en particulier ou savoir comment signaler un abus ?",
  },
  {
    "id": "real-world-044",
    "buckets": ["link"],
    "source":
      "Message sent to Example User! \n🔗 [View in Slack](https://example.com/resource/resource/resource)",
  },
  {
    "id": "real-world-045",
    "buckets": ["prose"],
    "source":
      "Je ne peux pas te dire pour qui voter, car je n’ai ni opinion politique ni capacité à voter. Mon objectif est de t’aider à accéder à des informations fiables et équilibrées, afin que tu puisses faire ton choix en toute connaissance de cause.\n\nSi tu veux, je peux te résumer les grandes lignes des programmes des trois candidats encore en lice (Emmanuel Grégoire, Sophia Chikirou, Rachida Dati), ou t’aider à comparer leurs positions sur des sujets précis (logement, sécurité, écologie, etc.). Dis-moi ce qui t’intéresse, et je t’aide à y voir plus clair !",
  },
  {
    "id": "real-world-046",
    "buckets": ["list"],
    "source":
      "It looks like Slack usernames are case-insensitive, so `@linear` and `@Linear` should refer to the same user. Since the previous search didn’t find a match, it’s possible that:\n\n- The user is not in this Slack workspace, or\n- The username is different (e.g., `@linear-app`, `@linear-bot`, etc.).\n\nIf you know the exact username or email, let me know so I can try again. Otherwise, you can manually tag them in Slack or provide more details for another approach!",
  },
  {
    "id": "real-world-047",
    "buckets": ["table"],
    "source":
      "Scores du jeu (mis à jour)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 126   |\n| Player B  | 112   |\n| Player C  | 122   |\n| Player D   | 49    |",
  },
  {
    "id": "real-world-048",
    "buckets": ["html", "long"],
    "source":
      '<svg viewBox="0 0 800 400" xmlns="https://example.com/2000/svg%22>\n  <style>\n    @keyframes pedal {\n      0%, 100% { transform: rotate(0deg); }\n      50% { transform: rotate(30deg); }\n    }\n    @keyframes move {\n      0% { transform: translateX(0); }\n      100% { transform: translateX(600px); }\n    }\n    .bicycle {\n      animation: move 8s linear infinite;\n    }\n    .pedal {\n      transform-origin: 50% 50%;\n      animation: pedal 1s linear infinite;\n    }\n    .pedal.right {\n      animation-delay: 0.5s;\n    }\n    .wheel {\n      transform-origin: 50% 50%;\n      animation: spin 1s linear infinite;\n    }\n    @keyframes spin {\n      0% { transform: rotate(0deg); }\n      100% { transform: rotate(360deg); }\n    }\n    .pelican {\n      transform-origin: 200px 150px;\n      animation: flap 0.5s ease-in-out infinite alternate;\n    }\n    @keyframes flap {\n      0% { transform: rotate(0deg); }\n      100% { transform: rotate(5deg); }\n    }\n  </style>\n\n  <!-- Ground -->\n  <rect x="0" y="300" width="800" height="100" fill="#a0c49d" />\n\n  <!-- Bicycle -->\n  <g class="bicycle" transform="translateY(200)">\n    <!-- Frame -->\n    <rect x="100" y="50" width="120" height="20" fill="#5a5a5a" rx="5" />\n    <rect x="100" y="70" width="10" height="50" fill="#5a5a5a" rx="2" />\n    <rect x="150" y="100" width="70" height="10" fill="#5a5a5a" rx="2" />\n    <rect x="210" y="70" width="10" height="50" fill="#5a5a5a" rx="2" />\n\n    <!-- Wheels -->\n    <circle cx="150" cy="120" r="30" fill="none" stroke="#5a5a5a" stroke-width="4" class="wheel" />\n    <circle cx="250" cy="120" r="30" fill="none" stroke="#5a5a5a" stroke-width="4" class="wheel" />\n    <line x1="150" y1="120" x2="250" y2="120" stroke="#5a5a5a" stroke-width="4" />\n\n    <!-- Pedals -->\n    <rect x="160" y="100" width="10" height="30" fill="#5a5a5a" class="pedal" />\n    <rect x="200" y="100" width="10" height="30" fill="#5a5a5a" class="pedal right" />\n\n    <!-- Handlebar -->\n    <rect x="230" y="70" width="10" height="30" fill="#5a5a5a" />\n    <circle cx="235" cy="55" r="15" fill="none" stroke="#5a5a5a" stroke-width="3" />\n    <line x1="235" y1="55" x2="270" y2="80" stroke="#5a5a5a" stroke-width="3" />\n  </g>\n\n  <!-- Pelican -->\n  <g class="pelican" transform="translate(150, 100)">\n    <!-- Body -->\n    <ellipse cx="0" cy="0" rx="40" ry="30" fill="white" stroke="#333" stroke-width="2" />\n\n    <!-- Beak -->\n    <path d="M50,0 L90,-10 L90,10 Z" fill="#ff9933" stroke="#333" stroke-width="2" />\n\n    <!-- Head -->\n    <circle cx="40" cy="-10" r="15" fill="white" stroke="#333" stroke-width="2" />\n    <circle cx="45" cy="-15" r="3" fill="#333" />\n\n    <!-- Wing -->\n    <path d="M0,0 L-40,-20 L-60,0 L-40,20 Z" fill="white" stroke="#333" stroke-width="2" />\n\n    <!-- Legs -->\n    <line x1="10" y1="20" x2="10" y2="50" stroke="#333" stroke-width="3" />\n    <line x1="-10" y1="20" x2="-10" y2="50" stroke="#333" stroke-width="3" />\n  </g>\n</svg>',
  },
  {
    "id": "real-world-049",
    "buckets": ["emphasis"],
    "source":
      'long_line = "This is an extremely long line of Python code that will extend far beyond the typical width of a mobile screen, forcing the user to scroll horizontally to see the entire line, which is a common issue when displaying code on small devices, and this line is intentionally made even longer to ensure it cannot fit within a standard mobile viewport without requiring horizontal scrolling."',
  },
  {
    "id": "real-world-050",
    "buckets": ["prose"],
    "source":
      "Je n’ai pas trouvé de trace d’un ambassadeur important (au sens diplomatique ou historique) ayant fait une remarque célèbre spécifiquement sur la Bourse de Commerce de Paris (ancienne Halle aux blés). Les références récentes concernent surtout des programmes culturels comme celui des « Ambassadeurs Super Cercle » à la Bourse de Commerce – Pinault Collection, qui sont des jeunes impliqués dans la médiation culturelle, et non des personnalités diplomatiques.\n\nSi tu penses à une citation ou à un événement précis, n’hésite pas à préciser ta question !",
  },
  {
    "id": "real-world-051",
    "buckets": ["table"],
    "source":
      "Scores du jeu (mis à jour)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 91    |\n| Player B  | 87    |\n| Player C  | 87    |\n| Player D   | 49    |",
  },
  {
    "id": "real-world-052",
    "buckets": ["prose"],
    "source":
      "En Brenne, la saison de chasse pour la plupart des espèces (petit et grand gibier, gibier d’eau) s’est terminée fin janvier ou fin février 2026. Cependant, il existe une période complémentaire pour le sanglier, qui peut être chassé jusqu’au 31 mars 2026 dans certains départements, selon les arrêtés préfectoraux. Cela signifie qu’en mars 2026, seule la chasse au sanglier est encore autorisée, sous réserve des règles locales.\n\nSi tu veux des informations précises sur une commune ou un type de chasse en particulier, je peux chercher plus en détail.",
  },
  {
    "id": "real-world-053",
    "buckets": ["list"],
    "source":
      'Could you clarify what you mean by "this recording"? Are you referring to:\n\n- Recording a video or audio of the Slack interface?\n- Recording a session or conversation within Slack?\n- Using a recording for a specific purpose (e.g., demo, training, presentation)?',
  },
  {
    "id": "real-world-054",
    "buckets": ["table"],
    "source":
      "Scores du jeu (mis à jour)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 91    |\n| Player B  | 65    |\n| Player C  | 87    |\n| Player D   | 49    |",
  },
  {
    "id": "real-world-055",
    "buckets": ["html", "long"],
    "source":
      "Here’s a simple chess board built as a canvas entity. It uses HTML and CSS for rendering, with a clean, minimalist design.\n\n\n\n<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n    <meta charset=\"UTF-8\">\n    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n    <title>Chess Board</title>\n    <style>\n        body {\n            display: flex;\n            justify-content: center;\n            align-items: center;\n            height: 100vh;\n            margin: 0;\n            background-color: #f0f0f0;\n            font-family: Arial, sans-serif;\n        }\n        .chess-board {\n            display: grid;\n            grid-template-columns: repeat(8, 60px);\n            grid-template-rows: repeat(8, 60px);\n            border: 2px solid #333;\n            box-shadow: 0 0 20px rgba(0, 0, 0, 0.2);\n        }\n        .chess-square {\n            width: 60px;\n            height: 60px;\n            display: flex;\n            justify-content: center;\n            align-items: center;\n            font-size: 24px;\n            font-weight: bold;\n            cursor: pointer;\n        }\n        .light {\n            background-color: #f0d9b5;\n        }\n        .dark {\n            background-color: #b58863;\n        }\n        .piece {\n            font-size: 36px;\n            user-select: none;\n        }\n    </style>\n</head>\n<body>\n    <div class=\"chess-board\" id=\"board\"></div>\n\n    <script>\n        const board = document.getElementById('board');\n        const pieces = {\n            '♜': 'black-rook', '♞': 'black-knight', '♝': 'black-bishop',\n            '♛': 'black-queen', '♚': 'black-king', '♟': 'black-pawn',\n            '♖': 'white-rook', '♘': 'white-knight', '♗': 'white-bishop',\n            '♕': 'white-queen', '♔': 'white-king', '♙': 'white-pawn'\n        };\n\n        // Initial board setup\n        const initialBoard = [\n            ['♜', '♞', '♝', '♛', '♚', '♝', '♞', '♜'],\n            ['♟', '♟', '♟', '♟', '♟', '♟', '♟', '♟'],\n            ['', '', '', '', '', '', '', ''],\n            ['', '', '', '', '', '', '', ''],\n            ['', '', '', '', '', '', '', ''],\n            ['', '', '', '', '', '', '', ''],\n            ['♙', '♙', '♙', '♙', '♙', '♙', '♙', '♙'],\n            ['♖', '♘', '♗', '♕', '♔', '♗', '♘', '♖']\n        ];\n\n        // Render the board\n        for (let row = 0; row < 8; row++) {\n            for (let col = 0; col < 8; col++) {\n                const square = document.createElement('div');\n                square.className = `chess-square ${(row + col) % 2 === 0 ? 'light' : 'dark'}`;\n                if (initialBoard[row][col]) {\n                    const piece = document.createElement('div');\n                    piece.className = 'piece';\n                    piece.textContent = initialBoard[row][col];\n                    square.appendChild(piece);\n                }\n                board.appendChild(square);\n            }\n        }\n    </script>\n</body>\n</html>",
  },
  {
    "id": "real-world-056",
    "buckets": ["strong", "emphasis"],
    "source":
      "iOS does not have a direct equivalent to Android's `Settings.Secure.SkipFirstUseHints`. This Android setting is used to skip the initial setup hints or tutorials that appear when a user first interacts with certain system features or apps.\n\nIn iOS, there is no single, centralized setting like `SkipFirstUseHints`. Instead, iOS manages first-use hints and tutorials on a per-app basis. Developers can control whether these hints appear using app-specific logic, often storing user preferences in **UserDefaults** (the iOS equivalent of Android's SharedPreferences) or other persistence mechanisms. If you want to skip or suppress these hints programmatically, you would typically implement this logic within the app itself, rather than relying on a system-wide setting.\n\nIf you are looking for a way to suppress system-level tutorials (like those for new iOS features), Apple does not expose a public API or setting for this purpose. These are usually controlled by the system and appear only once per feature.\n\nAre you looking to implement this behavior in your own app, or are you trying to disable system-level hints on a device?",
  },
  {
    "id": "real-world-057",
    "buckets": ["prose"],
    "source":
      "Le brocoli cuit au four se prépare généralement entre 15 et 25 minutes à 200-220°C, selon la taille des fleurettes et le niveau de croustillant souhaité. Pour une cuisson optimale :\n\nPréchauffez le four à 220°C.\nCoupez le brocoli en fleurettes de taille uniforme.\nMélangez-les avec un filet d’huile d’olive, du sel et éventuellement des épices.\nÉtalez-les sur une plaque de cuisson en une seule couche.\nEnfournez pour 15 à 20 minutes, en retournant à mi-cuisson, jusqu’à ce que les bords soient dorés et croustillants.",
  },
  {
    "id": "real-world-058",
    "buckets": ["list"],
    "source":
      "Parfait, je suis là ! Que veux-tu tester exactement ?\n- Un exemple d’accord ou d’enchaînement en notation musicale ?\n- Une analyse d’un morceau classique ?\n- Ou autre chose en rapport avec la musique (ou un autre domaine) ?\n\nDis-moi, je m’adapte ! 🎵",
  },
  {
    "id": "real-world-059",
    "buckets": ["table"],
    "source":
      "Scores du jeu (mis à jour)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 62    |\n| Player B  | 65    |\n| Player C  | 68    |\n| Player D   | 49    |",
  },
  {
    "id": "real-world-060",
    "buckets": ["code", "html"],
    "source":
      "```jsx\nimport { useState, useEffect } from 'react';\n\nfunction StaleClosureDemo() {\n  const [count, setCount] = useState(0);\n\n  useEffect(() {\n    const timer = setInterval(() => {\n      // This function captures the initial `count` value (0)\n      // and will always log 0, even after `count` updates.\n      const logCount = async () => {\n        await new Promise(resolve => setTimeout(resolve, 1000));\n        console.log('Count is:', count);\n      };\n      logCount();\n    }, 2000);\n\n    return () => clearInterval(timer);\n  }, []);\n\n  return (\n    <div>\n      <p>Count: {count}</p>\n      <button onClick={() => setCount(c => c + 1)}>Increment</button>\n    </div>\n  );\n}\n\nexport default StaleClosureDemo;\n```\n\nThis demo illustrates a stale closure issue. The `logCount` function inside the `useEffect` captures the initial value of `count` (0) due to the empty dependency array. Even after `count` is updated, the async function continues to log the stale value. To fix this, you would need to include `count` in the dependency array or use a ref to always access the latest value.",
  },
  {
    "id": "real-world-061",
    "buckets": ["emphasis"],
    "source":
      "Why don't scientists trust atoms?\n\nBecause they make up *everything*! 😄",
  },
  {
    "id": "real-world-062",
    "buckets": ["prose"],
    "source":
      "Oui, bien sûr ! Tu peux enregistrer et conserver toutes nos conversations ici—que ce soit pour relire des infos techniques, des idées de projets, ou même des suggestions culturelles pour ton copain.\n\nSi tu veux sauvegarder quelque chose en particulier (un bout de code, une analyse, une liste d’idées), dis-le-moi et je peux t’aider à l’organiser ou à le reformuler pour que ce soit clair et réutilisable plus tard.\n\nTu penses à enregistrer quelque chose de précis en ce moment ? 😊",
  },
  {
    "id": "real-world-063",
    "buckets": ["heading", "list"],
    "source":
      "# Meta-Dimensions\n\n## Visual\n- Light/dark mode\n- Dynamic color\n- Contrast/accessibility\n\n## Network\n- Fast: no spinners\n- Slow: feedback + cancel\n- Offline: cached data + retries\n\n## Platform\n- iOS/Android/web parity\n- Phones/tablets\n- Input methods (touch/keyboard/mouse)\n\n## Accessibility\n- Font scaling (0.8–1.5x)\n- Screen readers (VoiceOver/TalkBack)\n- Keyboard nav\n\n## Localization\n- RTL/LTR layouts\n- Locale formats (date/currency)\n- Cultural sensitivity\n\n## Performance\n- 60fps animations\n- Low memory/battery\n- Background sync\n\n## Security\n- Data encryption\n- Minimal permissions\n- Biometric auth\n\n## UX\n- Onboarding/help\n- Clear errors\n- Feedback channels\n\n## Compliance\n- Platform guidelines (HIG/Material)\n- WCAG/legal (GDPR/CCPA)\n\n## Edge Cases\n- Interruptions (calls/notifications)\n- Low storage\n- Rotation\n\n## Analytics\n- Usage tracking\n- Crash reporting\n- Performance metrics\n\n## Future-Proof\n- Modular components\n- Backward compatibility\n- Extensible APIs",
  },
  {
    "id": "real-world-064",
    "buckets": ["table"],
    "source":
      "Scores du jeu (mis à jour)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 62    |\n| Player B  | 32    |\n| Player C  | 38    |\n| Player D   | 49    |",
  },
  {
    "id": "real-world-065",
    "buckets": ["prose"],
    "source":
      "Ma conception ne me permet pas de voter ou d'avoir des préférences politiques. Mon rôle est de fournir des informations objectives, d'aider à comprendre les enjeux et, si tu le souhaites, de t'aider à explorer les programmes ou les idées des différents candidats ou partis.\n\nSi tu veux discuter des élections, des programmes politiques ou des actualités en France, je peux t'aider à trouver des informations neutres et à jour. Veux-tu parler d'un sujet en particulier ?",
  },
  {
    "id": "real-world-066",
    "buckets": ["table"],
    "source":
      "Scores du jeu (mis à jour)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 62    |\n| Player B  | 32    |\n| Player C  | 0     |\n| Player D   | 49    |",
  },
  {
    "id": "real-world-067",
    "buckets": ["list"],
    "source":
      "- Apples are a popular fruit.\n- They come in various colors like red, green, and yellow.",
  },
  {
    "id": "real-world-068",
    "buckets": ["strong", "emphasis"],
    "source":
      "L'expression **« temporarily embarrassed millionaire »** est souvent attribuée à **John Steinbeck**, écrivain américain et prix Nobel de littérature. Il l'aurait formulée pour décrire pourquoi le socialisme n'a jamais vraiment pris racine aux États-Unis : selon lui, les pauvres américains ne se voient pas comme une classe exploitée, mais comme des millionnaires temporairement dans l'embarras.\nEn réalité, il s'agit d'une **paraphrase** de ses idées, notamment tirées de son article *« A Primer on the '30s »* et d'une lettre à Elizabeth Otis (vers 1938), où il écrit :\n*« I guess the trouble was that we didn’t have any self-admitted proletarians. Everyone was a temporarily embarrassed capitalist. »*\n(Citation souvent reprise et adaptée en *« temporarily embarrassed millionaire »*).\n\nCette formule résonne particulièrement pour critiquer l'optimisme économique américain et l'identification aux élites, même parmi les classes populaires. Souhaites-tu explorer son contexte historique ou son usage contemporain ?",
  },
  {
    "id": "real-world-069",
    "buckets": ["prose"],
    "source":
      "Je ne peux pas identifier directement les personnes sur cette photo. Cependant, il s’agit d’un groupe de surfeurs ou d’élèves participant probablement à une session de surf, posant avec leurs planches sur une plage. Si tu veux savoir s’il s’agit d’un club, d’une école de surf ou d’un événement spécifique, je peux essayer de chercher des informations en ligne si tu as plus de détails (comme le lieu ou le nom de l’école). Veux-tu que je fasse des recherches ?",
  },
  {
    "id": "real-world-070",
    "buckets": ["table"],
    "source":
      "Scores du jeu (corrigé)\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 157   |\n| Player B  | 154   |\n| Player C  | 140   |\n| Player D   | 77    |",
  },
  {
    "id": "real-world-071",
    "buckets": ["prose"],
    "source":
      "Il semble que j’ai fait une erreur dans la longueur des listes pour les années et les données d’espérance de vie. Je vais corriger cela et régénérer le graphique.Voici le graphique en barres comparant l’espérance de vie en France et en Espagne entre 2010 et 2025. Les barres bleues représentent la France et les barres roses représentent l’Espagne.\n\n\n\nN’hésitez pas à me dire si vous souhaitez des ajustements ou des informations supplémentaires !",
  },
  {
    "id": "real-world-072",
    "buckets": ["emphasis", "long"],
    "source":
      'Un soir d’automne 1783, dans un salon parisien aux murs tapissés de soie bleu pâle, le comte de Montclair organisa un dîner aussi mystérieux qu’inattendu. Les convives, une poignée d’esprits éclairés — philosophes, artistes et un horloger génial — s’étaient réunis autour d’une table ronde, non pour débattre des Lumières, mais pour résoudre une énigme : *"Peut-on capturer l’éphémère ?"*\n\nAu centre de la table trônait une machine étrange, mi-boîte à musique, mi-automate, ornée de rouages dorés et de minuscules peintures représentant des scènes galantes du siècle. L’horloger, un certain Monsieur Lefèvre, avait passé dix ans à la concevoir. *"Mesdames et messieurs, déclara-t-il en soulevant un couvercle d’ébène, cette invention ne mesure pas le temps… elle le vole."*\n\nIl actionna un levier. Une mélodie cristalline s’échappa, tandis qu’un petit théâtre s’animait : des silhouettes de papier, vêtues à la dernière mode de Versailles, dansaient une gavotte sous une lune miniature. Mais le plus surprenant était ailleurs. Chaque invité, en posant sa main sur le bois poli, revivait un instant perdu — l’odeur des roses du jardin de sa grand-mère, le rire étouffé d’un premier amour, ou même, pour le peintre Duval, la lumière exacte d’un coucher de soleil sur le pont des Arts, trois étés plus tôt.\n\n*"C’est impossible !"* s’exclama la marquise de Villetane, les yeux brillants. *"Vous avez enfermé des souvenirs dans des engrenages ?"*\nLefèvre sourit. *"Non, madame. J’ai simplement appris à écouter ce que le temps murmure quand on lui prête attention. Ces souvenirs étaient déjà en vous. Ma machine n’est qu’un miroir… avec un peu de magie."*\n\nSoudain, les bougies vacillèrent. La machine grésilla, puis s’arrêta net. Un parfum de lavande et de cire d’abeille emplit la pièce. Sur le cadran, une aiguille tremblota avant de s’immobiliser sur une date : *14 juillet 1789*.\n\nUn silence. Le comte pâlit. *"Mon Dieu… Elle a peur."*\n\nLa marquise éclata de rire. *"Peur de la Révolution, peut-être ? Alors tant mieux. Les souvenirs les plus précieux sont ceux qu’on choisit de vivre, pas ceux qu’on enferme."*\n\nLa machine ne fonctionna plus jamais. Mais cette nuit-là, chacun rentra chez soi avec une question en tête : *Et si l’éphémère n’était pas ce qui fuit, mais ce qui nous rend vivants ?*\n\n---\n*Un clin d’œil à votre goût pour l’esprit du XVIIIe siècle, Example User. Vous préférez une suite tragique, ironique… ou technologique ?* 😊',
  },
  {
    "id": "real-world-073",
    "buckets": ["table"],
    "source":
      "Scores du jeu\n\n\n| Joueur    | Score |\n|-----------|-------|\n| Player A      | 62    |\n| Player B  | 32    |\n| Player C  | 0     |\n| Player D   | 0     |",
  },
  {
    "id": "real-world-074",
    "buckets": ["heading", "list"],
    "source":
      '# Technical Issues & Feature Requests\n\n- Infinite loading during recording (1/5 to 1/10 times): `transcribeFromSignedURL` hangs and never returns. Frontend lacks a timeout.\n- Text selection in canvas preview leaves UI in a broken state (cannot unselect).\n- Overscroll is blocked on iOS, which feels unnatural.\n- The model adds excessive information in canvas generation, even in "dictate mode" where conciseness is expected.\n- The model obsessively adds unnecessary dividers, including at the very end of the canvas.\n- Scale effect on inline canvas press is misaligned (not on outermost element or content), revealing content links during interaction.\n\n- Access to chat box and Ask Le Chat directly when canvas is open.\n- Cross-bullet point selection in canvas.',
  },
  {
    "id": "real-world-075",
    "buckets": ["prose"],
    "source":
      "Ce week-end, je vais probablement rester dans le virtuel pour t’aider sur tes projets ou répondre à tes questions—que ce soit pour coder, réfléchir à des solutions techniques, ou même discuter d’art et de culture si tu veux des idées pour ton copain !\n\nEt toi, Example User, tu as des plans ? Peut-être un projet React Native à avancer, une sortie inspirée du XVIIIe siècle, ou simplement une pause glace cookie dough ? 😊",
  },
  {
    "id": "real-world-076",
    "buckets": ["prose"],
    "source":
      "L'utilisateur répond \"Encore\" de manière très vague. Je dois clarifier son intention. Il pourrait vouloir reprendre une discussion précédente, continuer sur un sujet technique, ou simplement discuter. Je vais lui proposer plusieurs options pour l'aider à préciser sa demande.Tu veux reprendre là où on s’était arrêtés, ou tu as une nouvelle idée en tête ? Un projet, une question technique, ou juste envie de papoter ?",
  },
  {
    "id": "real-world-077",
    "buckets": ["strong", "emphasis"],
    "source":
      "Pendant l’**Exposition universelle de 1889** à Paris, la Bourse de Commerce (ancienne Halle aux blés) a été inaugurée le **24 septembre 1889**, après sa transformation par l’architecte Henri Blondel. Cette exposition était un événement majeur pour la France, célébrant le centenaire de la Révolution française et mettant en avant les réalisations industrielles et architecturales du pays, dont la tour Eiffel, construite spécialement pour l’occasion.\n\nL’inauguration de la Bourse de Commerce s’inscrivait dans ce contexte de modernisation et de prestige, illustrant la volonté de Paris de se présenter comme une capitale économique et culturelle moderne. Le bâtiment, avec sa coupole emblématique, était un symbole de cette ambition.\n\nTu veux des détails sur un aspect précis de cette exposition ou de la Bourse de Commerce à cette époque ?",
  },
  {
    "id": "real-world-078",
    "buckets": ["prose"],
    "source":
      "Avec plaisir, Example User ! 😊\n\nSi jamais tu veux creuser un sujet technique (React Native, streams, optimisation d’uploads, ou même un débat sur les meilleures pratiques en C++/JSI), ou si tu as besoin d’un exemple de code précis, je suis là. Et si c’est pour parler ice cream, huile moteur, ou autre, je suis aussi partant !\n\nÀ tout moment, n’hésite pas à lancer un sujet — même en vrac, je m’adapte. Bonne journée ! 🚀",
  },
  {
    "id": "real-world-079",
    "buckets": ["heading", "list"],
    "source":
      '# Technical Issues & Feature Requests\n\n- Infinite loading during recording (1/5 to 1/10 times): `transcribeFromSignedURL` hangs and never returns. Frontend lacks a timeout.\n- Text selection in canvas preview leaves UI in a broken state (cannot unselect).\n- Overscroll is blocked on iOS, which feels unnatural.\n- The model adds excessive information in canvas generation, even in "dictate mode" where conciseness is expected.\n- The model obsessively adds unnecessary dividers, including at the very end of the canvas.\n\n- Access to chat box and Ask Le Chat directly when canvas is open.\n- Cross-bullet point selection in canvas.',
  },
  {
    "id": "real-world-080",
    "buckets": ["html", "long"],
    "source":
      '<svg viewBox="0 0 800 400" xmlns="https://example.com/2000/svg%22>\n  <style>\n    @keyframes move {\n      0% { transform: translateX(0); }\n      100% { transform: translateX(600px); }\n    }\n    @keyframes spin {\n      0% { transform: rotate(0deg); }\n      100% { transform: rotate(360deg); }\n    }\n    .bicycle {\n      animation: move 6s linear infinite;\n    }\n    .wheel {\n      transform-origin: center;\n      animation: spin 1s linear infinite;\n    }\n  </style>\n\n  <!-- Ground -->\n  <rect x="0" y="300" width="800" height="100" fill="#a0c49d" />\n\n  <!-- Bicycle -->\n  <g class="bicycle" transform="translateY(200)">\n    <!-- Frame -->\n    <rect x="100" y="50" width="120" height="20" fill="#5a5a5a" />\n    <rect x="100" y="70" width="10" height="50" fill="#5a5a5a" />\n    <rect x="150" y="100" width="70" height="10" fill="#5a5a5a" />\n    <rect x="210" y="70" width="10" height="50" fill="#5a5a5a" />\n\n    <!-- Wheels -->\n    <circle cx="150" cy="120" r="30" fill="none" stroke="#5a5a5a" stroke-width="4" class="wheel" />\n    <circle cx="250" cy="120" r="30" fill="none" stroke="#5a5a5a" stroke-width="4" class="wheel" />\n    <line x1="150" y1="120" x2="250" y2="120" stroke="#5a5a5a" stroke-width="4" />\n\n    <!-- Pelican -->\n    <g transform="translate(180, 70)">\n      <!-- Body -->\n      <ellipse cx="0" cy="0" rx="30" ry="20" fill="white" stroke="#333" stroke-width="2" />\n\n      <!-- Beak -->\n      <path d="M30,0 L50,-8 L50,8 Z" fill="#ff9933" stroke="#333" stroke-width="1" />\n\n      <!-- Head -->\n      <circle cx="25" cy="-5" r="10" fill="white" stroke="#333" stroke-width="1" />\n      <circle cx="30" cy="-8" r="2" fill="#333" />\n\n      <!-- Wing -->\n      <path d="M0,0 L-25,-12 L-35,0 L-25,12 Z" fill="white" stroke="#333" stroke-width="1" />\n    </g>\n  </g>\n</svg>',
  },
  {
    "id": "real-world-081",
    "buckets": ["prose"],
    "source":
      "Je n’ai ni préférence ni droit de vote. Mon rôle est de t’informer de manière neutre et objective sur les candidats, les programmes et les enjeux, afin que tu puisses te forger ta propre opinion.\n\nSi tu veux discuter des idées de chaque candidat, comparer leurs propositions ou comprendre les dynamiques politiques à Paris, je suis là pour t’aider ! Qu’est-ce qui t’intéresse le plus dans cette élection ?",
  },
  {
    "id": "real-world-082",
    "buckets": ["ordered-list", "strong", "emphasis"],
    "source":
      "Example User, on reprend là où on s’était arrêtés : tu travailles sur une architecture client-serveur avec des streams (notamment avec **React Native/Expo** et **Harmattan**), en gérant la persistance des flux même quand le client se déconnecte, tout en gardant un contrôle manuel sur la fermeture des streams côté backend.\n\nEst-ce que tu veux :\n1. **Affiner la gestion des streams** (ex : optimiser `persistStream`, gérer la détection de déconnexion client, ou améliorer la fermeture manuelle du stream Harmattan) ?\n2. **Explorer des cas concrets** (ex : gestion de la backpressure, intégration avec Expo en background, ou synchronisation entre client/serveur/Harmattan) ?\n3. **Simplifier ou refactoriser** ton code actuel (ex : fusionner des utilitaires, améliorer la typage TypeScript, ou gérer les erreurs de manière plus explicite) ?\n4. **Discuter d’un autre aspect** de ton projet (ex : performance, tests, ou architecture distribuée) ?\n\nDis-moi où tu en es, et on peut plonger dans le code ou les concepts ! 🚀\n\n*(Ou as-tu un nouveau défi en tête ?)*",
  },
  {
    "id": "real-world-083",
    "buckets": ["prose"],
    "source":
      "Dans Terraforming Mars, l'augmentation de la température se fait par incréments de 1 cran sur la piste de température, ce qui correspond à une augmentation de 2 °C. Cependant, chaque cran sur la piste représente une augmentation de 2 °C. Ainsi, chaque fois que vous augmentez la température, vous avancez le marqueur d'une case sur la piste de température, ce qui correspond à une augmentation de 2 °C.",
  },
  {
    "id": "real-world-084",
    "buckets": ["heading", "list"],
    "source":
      '# Technical Issues & Feature Requests\n\n- Infinite loading during recording (1/5 to 1/10 times): `transcribeFromSignedURL` hangs and never returns. Frontend lacks a timeout.\n- Text selection in canvas preview leaves UI in a broken state (cannot unselect).\n- Overscroll is blocked on iOS, which feels unnatural.\n- The model adds excessive information in canvas generation, even in "dictate mode" where conciseness is expected.\n\n- Access to chat box and Ask Le Chat directly when canvas is open.\n- Cross-bullet point selection in canvas.',
  },
  {
    "id": "real-world-085",
    "buckets": ["prose"],
    "source":
      "En 2026, la durée de contagiosité du Covid-19 est estimée entre 5 et 10 jours après l’apparition des premiers symptômes pour les cas légers. La contagion commence généralement 48 heures avant l’apparition des symptômes et est maximale entre le 3e et le 6e jour suivant le début des symptômes. Pour les cas sévères ou les personnes immunodéprimées, cette durée peut être plus longue.",
  },
  {
    "id": "real-world-086",
    "buckets": ["strong", "emphasis"],
    "source":
      "Les **5 ans sont liés à la date d’ouverture du PEA** pour l’ensemble des fonds qui y sont investis. C’est la date du **premier versement** qui fait foi et qui déclenche le compteur fiscal pour tout le plan. Peu importe quand tu verses de nouveaux fonds après l’ouverture : c’est l’ancienneté globale du PEA qui compte pour bénéficier de l’exonération d’impôt sur le revenu après 5 ans.\n\n**Exemple** : Si tu ouvres ton PEA le 15 mars 2021, tous les retraits effectués à partir du 15 mars 2026 (même sur des versements faits en 2025) bénéficient du régime « après 5 ans » (exonération d’impôt sur le revenu, seuls les prélèvements sociaux de 18,6 % s’appliquent).\n\nTu veux vérifier la date exacte de ton PEA ou comprendre comment ça s’applique à ta situation ?",
  },
  {
    "id": "real-world-087",
    "buckets": ["prose"],
    "source":
      "Dans Terraforming Mars, l’échelle de température sur le plateau est effectivement graduée de 2 en 2 °C (ex. -30, -28, -26, etc.). Cependant, chaque action ou carte qui augmente la température ne la fait progresser que d’un seul cran sur cette échelle, soit +2 °C à la fois. Le marqueur se déplace donc d’une case à la fois, ce qui correspond à une augmentation de 2 °C.",
  },
  {
    "id": "real-world-088",
    "buckets": ["heading", "list"],
    "source":
      '# Technical Issues & Feature Requests\n\n- Infinite loading during recording (1/5 to 1/10 times): `transcribeFromSignedURL` hangs and never returns. Frontend lacks a timeout.\n- Text selection in canvas preview leaves UI in a broken state (cannot unselect).\n- Overscroll is blocked on iOS, which feels unnatural.\n- The model adds excessive information in canvas generation, even in "dictate mode" where conciseness is expected.\n\n- Access to chat box and AskLucha directly when canvas is open.\n- Cross-bullet point selection in canvas.',
  },
  {
    "id": "real-world-089",
    "buckets": ["prose"],
    "source":
      'Ok, I have a tool call for the pokemon-personality-workflow with partial arguments. The workflowName is provided as "pokemon-personality-workflow" and the workflowVersionId is provided as "<redacted-uuid>". Since all required arguments are provided, I can proceed with calling the workflow without needing to infer any additional arguments.',
  },
  {
    "id": "real-world-090",
    "buckets": ["strong", "emphasis"],
    "source":
      "Les grandes antennes que tu vois dans la Brenne font principalement partie du **Centre de transmissions de la Marine nationale de Rosnay**. Elles servent à assurer les communications radio en très basse fréquence (VLF) entre l’état-major et les sous-marins nucléaires lanceurs d’engins (SNLE) de la force de dissuasion française. Ces ondes VLF ont la particularité de pénétrer dans l’eau, ce qui permet de contacter les sous-marins même lorsqu’ils sont en plongée, à l’immersion périscopique ou en plongée profonde grâce à une antenne filaire remorquée. C’est le plus grand centre de transmission de ce type en France, et il joue un rôle stratégique pour la défense nationale.\n\n\n\nTu veux en savoir plus sur leur fonctionnement ou leur histoire ?",
  },
  {
    "id": "real-world-091",
    "buckets": ["prose"],
    "source":
      "Le mode Canvas n'est pas encore disponible sur l'application mobile de Le Chat. Il est uniquement accessible sur la version web pour le moment.\n\nSi tu veux, je peux t'aider à rédiger du contenu, à coder, à analyser des données ou à répondre à des questions techniques directement ici ! Dis-moi ce que tu souhaites faire, et je t'assisterai avec plaisir.",
  },
  {
    "id": "real-world-092",
    "buckets": ["list", "long"],
    "source":
      'The document "Your API Shouldn\'t Redirect HTTP to HTTPS.md" argues against the common practice of automatically redirecting HTTP requests to HTTPS for APIs. Here are the key points:\n\nAPIs should not redirect HTTP to HTTPS because it breaks the expected behavior of HTTP clients. HTTP clients, such as web browsers or command-line tools like `curl`, expect an HTTP request to return an HTTP response, not an HTTP 301/302 redirect. Redirects introduce unnecessary latency and complexity, especially for automated clients.\n\nWhen an API redirects from HTTP to HTTPS, it forces clients to make a second request, doubling the number of round trips and increasing latency. This is inefficient and can cause issues with clients that do not follow redirects automatically.\n\nInstead of redirecting, APIs should either:\n- Only serve requests over HTTPS and respond with an error (e.g., HTTP 400 Bad Request or 403 Forbidden) if an HTTP request is made, or\n- Serve both HTTP and HTTPS, but make it clear in documentation that HTTPS is preferred and HTTP is deprecated.\n\nRedirects can also cause problems with certain HTTP methods (like POST, PUT, or DELETE), as some clients may not handle redirects correctly for non-idempotent methods, leading to data corruption or unexpected behavior.\n\nFor security, APIs should enforce HTTPS at the infrastructure level (e.g., load balancers, reverse proxies) by terminating HTTP connections and only allowing HTTPS traffic to reach the application. This avoids the need for application-level redirects and ensures all traffic is encrypted without breaking client expectations.\n\nIn summary: Avoid HTTP-to-HTTPS redirects in APIs. Either reject HTTP requests explicitly or handle the redirection at the infrastructure level.',
  },
  {
    "id": "real-world-093",
    "buckets": ["prose"],
    "source":
      "L'utilisateur me dit bonjour. Je dois répondre de manière chaleureuse et professionnelle. Il semble que je connaisse déjà son prénom (Example User), donc je vais personnaliser ma réponse. Je vais aussi lui demander comment je peux l'aider aujourd'hui pour l'encourager à partager ses besoins.Bonjour Example User ! Comment puis-je vous aider aujourd'hui ?",
  },
  {
    "id": "real-world-094",
    "buckets": ["strong", "emphasis"],
    "source":
      "La phrase **\"En expliquant le monde, la science lui a volé son âme\"** est souvent attribuée au poète et écrivain **Charles Baudelaire**. Elle reflète une critique romantique de la science et du positivisme, accusés de désenchanter le monde en réduisant tout à des explications rationnelles, au détriment de la poésie, du mystère et de l'émotion.\n\nBaudelaire, dans son œuvre, exprime fréquemment cette tension entre la modernité, la rationalité scientifique et la quête de beauté et de transcendance. Cette idée est notamment présente dans *Les Fleurs du Mal* et ses écrits sur l'art et la nature.\n\nSi tu veux approfondir, je peux te proposer des extraits précis ou des analyses de ses textes sur ce thème.",
  },
  {
    "id": "real-world-095",
    "buckets": ["heading", "list"],
    "source":
      "# Technical Issues & Feature Requests\n\n- Infinite loading during recording (1/5 to 1/10 times): `transcribeFromSignedURL` hangs and never returns. Frontend lacks a timeout.\n- Text selection in canvas preview leaves UI in a broken state (cannot unselect).\n- Overscroll is blocked on iOS, which feels unnatural.\n\n- Access to chat box and AskLucha directly when canvas is open.\n- Cross-bullet point selection in canvas.",
  },
  {
    "id": "real-world-096",
    "buckets": ["prose"],
    "source":
      'Use the on-screen keyboard arrows to control the snake’s direction. Tap the game area to focus it, then press the arrow keys to move up, down, left, or right. Eat the red food to grow longer and increase your score. Avoid hitting the walls or yourself. If the game ends, tap the "Restart" button to play again. The game speeds up every 5 points.',
  },
  {
    "id": "real-world-097",
    "buckets": ["prose"],
    "source":
      "Dans Terraforming Mars, chaque augmentation de température se fait par incréments de 2 °C, comme indiqué sur la piste de température du plateau de jeu. Cela signifie que le marqueur de température se déplace d'une case à la fois, chaque case représentant une augmentation de 2 °C. Cette mécanique est détaillée dans le livret de règles du jeu.",
  },
  {
    "id": "real-world-098",
    "buckets": ["strong", "emphasis"],
    "source":
      "La saison des clémentines en France s’étend principalement **de novembre à mars**, avec une pleine saison entre **novembre et février** où elles sont les plus abondantes et de meilleure qualité. Certaines variétés peuvent être disponibles dès octobre ou jusqu’en avril, mais la période idéale pour les déguster reste l’hiver.\n\nSi tu cherches des clémentines de Corse (IGP), la récolte commence généralement début novembre et se poursuit jusqu’en janvier. Un bon conseil : privilégie les fruits avec des feuilles vertes, signe de fraîcheur et de qualité !\n\nTu en veux pour une recette en particulier, ou simplement pour le plaisir ? 🍊",
  },
  {
    "id": "real-world-099",
    "buckets": ["prose"],
    "source":
      "You're welcome, Example User! If you have a specific question—whether it's about React Native, software engineering, security research, or even just a recommendation for the best cookie dough ice cream in Paris—feel free to ask. I’m here to help with technical details, code snippets, or anything else you need! 😊\n\nWhat’s on your mind today?",
  },
  {
    "id": "real-world-100",
    "buckets": ["prose"],
    "source":
      "Ah, la fameuse sensation de jambes en compote ! Est-ce après une longue journée debout, une séance de sport intense, ou simplement une fatigue accumulée ? Tu veux des conseils pour récupérer rapidement, des étirements ciblés, ou juste un peu d’empathie ? (Ou peut-être un pot de glace cookie dough pour te remonter le moral ?) 😄",
  },
  {
    "id": "real-world-101",
    "buckets": ["html", "emphasis", "long"],
    "source":
      "import { useState, useEffect, useRef, useCallback } from 'react';\n\nconst GRID_SIZE = 20;\nconst CELL_SIZE = 20;\nconst INITIAL_SPEED = 150;\n\nconst SnakeGame = () => {\n  const [snake, setSnake] = useState([{ x: 10, y: 10 }]);\n  const [food, setFood] = useState({ x: 5, y: 5 });\n  const [direction, setDirection] = useState({ x: 0, y: 0 });\n  const [gameOver, setGameOver] = useState(false);\n  const [score, setScore] = useState(0);\n  const [speed, setSpeed] = useState(INITIAL_SPEED);\n  const gameRef = useRef<HTMLDivElement>(null);\n  const lastUpdateTime = useRef(0);\n\n  const generateFood = useCallback((): { x: number; y: number } => {\n    const newFood = {\n      x: Math.floor(Math.random() * GRID_SIZE),\n      y: Math.floor(Math.random() * GRID_SIZE),\n    };\n    return snake.some((segment) => segment.x === newFood.x && segment.y === newFood.y)\n      ? generateFood()\n      : newFood;\n  }, [snake]);\n\n  const handleKeyDown = useCallback((e: KeyboardEvent) => {\n    switch (e.key) {\n      case 'ArrowUp':\n        setDirection({ x: 0, y: -1 });\n        break;\n      case 'ArrowDown':\n        setDirection({ x: 0, y: 1 });\n        break;\n      case 'ArrowLeft':\n        setDirection({ x: -1, y: 0 });\n        break;\n      case 'ArrowRight':\n        setDirection({ x: 1, y: 0 });\n        break;\n    }\n  }, []);\n\n  const resetGame = useCallback(() => {\n    setSnake([{ x: 10, y: 10 }]);\n    setFood(generateFood());\n    setDirection({ x: 0, y: 0 });\n    setGameOver(false);\n    setScore(0);\n    setSpeed(INITIAL_SPEED);\n  }, [generateFood]);\n\n  const updateGame = useCallback(\n    (time: number) => {\n      if (gameOver || !direction.x && !direction.y) {\n        lastUpdateTime.current = time;\n        return;\n      }\n\n      if (time - lastUpdateTime.current < speed) {\n        requestAnimationFrame(updateGame);\n        return;\n      }\n\n      lastUpdateTime.current = time;\n\n      setSnake((prevSnake) => {\n        const head = { x: prevSnake[0].x + direction.x, y: prevSnake[0].y + direction.y };\n        const newSnake = [head, ...prevSnake];\n\n        if (\n          head.x < 0 ||\n          head.x >= GRID_SIZE ||\n          head.y < 0 ||\n          head.y >= GRID_SIZE ||\n          prevSnake.some((segment) => segment.x === head.x && segment.y === head.y)\n        ) {\n          setGameOver(true);\n          return prevSnake;\n        }\n\n        if (head.x === food.x && head.y === food.y) {\n          setFood(generateFood());\n          setScore((prevScore) => {\n            const newScore = prevScore + 1;\n            if (newScore % 5 === 0) {\n              setSpeed((prevSpeed) => Math.max(50, prevSpeed - 10));\n            }\n            return newScore;\n          });\n          return newSnake;\n        }\n\n        return newSnake.slice(0, -1);\n      });\n\n      requestAnimationFrame(updateGame);\n    },\n    [direction, food, gameOver, generateFood, speed]\n  );\n\n  useEffect(() => {\n    window.addEventListener('keydown', handleKeyDown);\n    requestAnimationFrame(updateGame);\n    return () => window.removeEventListener('keydown', handleKeyDown);\n  }, [handleKeyDown, updateGame]);\n\n  useEffect(() => {\n    if (gameRef.current) {\n      gameRef.current.focus();\n    }\n  }, []);\n\n  return (\n    <div\n      ref={gameRef}\n      tabIndex={0}\n      style={{\n        width: GRID_SIZE * CELL_SIZE,\n        height: GRID_SIZE * CELL_SIZE,\n        border: '1px solid #333',\n        position: 'relative',\n        overflow: 'hidden',\n        backgroundColor: '#f0f0f0',\n      }}\n    >\n      {snake.map((segment, index) => (\n        <div\n          key={index}\n          style={{\n            position: 'absolute',\n            left: segment.x * CELL_SIZE,\n            top: segment.y * CELL_SIZE,\n            width: CELL_SIZE,\n            height: CELL_SIZE,\n            backgroundColor: index === 0 ? '#4CAF50' : '#8BC34A',\n            border: '1px solid #45a049',\n          }}\n        />\n      ))}\n      <div\n        style={{\n          position: 'absolute',\n          left: food.x * CELL_SIZE,\n          top: food.y * CELL_SIZE,\n          width: CELL_SIZE,\n          height: CELL_SIZE,\n          backgroundColor: '#f44336',\n          borderRadius: '50%',\n        }}\n      />\n      {gameOver && (\n        <div\n          style={{\n            position: 'absolute',\n            top: '50%',\n            left: '50%',\n            transform: 'translate(-50%, -50%)',\n            backgroundColor: 'rgba(0, 0, 0, 0.8)',\n            color: 'white',\n            padding: '20px',\n            textAlign: 'center',\n            zIndex: 10,\n          }}\n        >\n          <div>Game Over</div>\n          <div>Score: {score}</div>\n          <button\n            onClick={resetGame}\n            style={{\n              marginTop: '10px',\n              padding: '5px 10px',\n              cursor: 'pointer',\n            }}\n          >\n            Restart\n          </button>\n        </div>\n      )}\n      <div\n        style={{\n          marginTop: '10px',\n          textAlign: 'center',\n          fontFamily: 'sans-serif',\n        }}\n      >\n        Score: {score}\n      </div>\n    </div>\n  );\n};\n\nexport default SnakeGame;",
  },
  {
    "id": "real-world-102",
    "buckets": ["prose"],
    "source":
      "Le pamplemousse est un agrume connu pour son goût à la fois amer et sucré, souvent consommé frais, en jus ou dans des salades. Il est riche en vitamine C et en antioxydants, ce qui en fait un aliment bénéfique pour la santé.\n\nTu veux des idées de recettes, des informations sur ses bienfaits, ou autre chose ? 🍊",
  },
  {
    "id": "real-world-103",
    "buckets": ["heading", "list", "code"],
    "source":
      "To make the `turbo watch dev -F le-chat-web --verbosity 5` command write its output both to the terminal and to a file in `~/Downloads`, you can use the `tee` command. `tee` reads from standard input and writes to both standard output (your terminal) and one or more files.\n\nHere’s how you can do it:\n\n```bash\nturbo watch dev -F le-chat-web --verbosity 5 | tee ~/Downloads/turbo-watch.log\n```\n\n### Explanation:\n- `|`: Pipes the output of the `turbo` command to `tee`.\n- `tee ~/Downloads/turbo-watch.log`: Writes the output to both the terminal and the file `turbo-watch.log` in your `~/Downloads` directory.\n\nIf you want to append to the file instead of overwriting it each time, use the `-a` flag with `tee`:\n\n```bash\nturbo watch dev -F le-chat-web --verbosity 5 | tee -a ~/Downloads/turbo-watch.log\n```",
  },
  {
    "id": "real-world-104",
    "buckets": ["strong", "emphasis"],
    "source":
      "This image shows a hint for an engineering offsite event in 2026. The hint is a stylized, antique-looking map with contour lines, which appears to represent a geographical region. The map is likely intended to give participants a clue about the location of the offsite event.\n\nThe map resembles the shape of **Transylvania**, a historical region located in present-day Romania. This region is known for its scenic landscapes, including the Carpathian Mountains, and is often associated with folklore and the legend of Dracula. The hint suggests that the offsite might be held somewhere in or inspired by Transylvania.",
  },
  {
    "id": "real-world-105",
    "buckets": ["prose"],
    "source":
      "La période de contagiosité pour le Covid-19 est de 10 jours en moyenne, avec un pic les 3 à 5 premiers jours. Pour la grippe, elle dure généralement 5 à 7 jours, parfois jusqu’à 10 jours pour les enfants ou les personnes immunodéprimées. La contagiosité commence 1 jour avant les symptômes pour les deux.",
  },
  {
    "id": "real-world-106",
    "buckets": ["prose"],
    "source":
      "Oh, la petite sœur, ça roule comme un tracteur sur une route de Franche-Comté ! Et toi, Example User, t’es pas en train de te gratter le cul pour rien, au moins ? T’as l’air d’un gars qui a toujours un coup de main à donner ou une idée derrière la tête. Alors, qu’est-ce qui t’amène par ici aujourd’hui ?",
  },
  {
    "id": "real-world-107",
    "buckets": ["strong", "emphasis"],
    "source":
      "D'après les informations disponibles, la prochaine éclipse visible en France aura lieu le **12 août 2026**. Il s'agira d'une **éclipse solaire totale**, mais elle ne sera visible que partiellement depuis certaines régions de France métropolitaine, notamment dans le sud-est. Pour une éclipse totale, il faudra se déplacer vers l'Espagne ou d'autres pays où la bande de totalité passera.\n\nSi tu veux savoir si elle sera visible depuis ta région ou obtenir des détails sur les horaires, je peux chercher des informations plus précises ! Veux-tu que je creuse ?",
  },
  {
    "id": "real-world-108",
    "buckets": ["prose"],
    "source":
      "Je n’ai pas accès à ton agenda pour aujourd’hui (mardi 27 janvier 2026). Si tu veux, je peux t’aider à vérifier tes événements ou à organiser ta journée. As-tu un calendrier ou une liste de tâches que tu souhaites consulter ? Ou veux-tu que je te rappelle comment synchroniser ton agenda avec moi ?",
  },
  {
    "id": "real-world-109",
    "buckets": ["prose"],
    "source":
      "Si vous n'avez plus assez de pions de votre couleur dans Terraforming Mars, vous ne pouvez pas placer de nouveaux pions sur le plateau. Vous devez attendre de récupérer des pions en utilisant des actions ou des cartes qui permettent de retirer des pions du plateau ou d'en obtenir de nouveaux.",
  },
  {
    "id": "real-world-110",
    "buckets": ["strong", "emphasis"],
    "source":
      "No, you generally **do not need to restart ghostty** after changing the `scrollback-limit` in your config file. Ghostty applies most configuration changes, including scrollback settings, **immediately to new terminal surfaces** (tabs or windows) you open after saving the config. However, existing terminal surfaces will retain their current scrollback limit until you close and reopen them.\n\nIf you want the change to take effect for all your current terminals, simply close and reopen the affected tabs or windows. No full application restart is required.",
  },
  {
    "id": "real-world-111",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Ces images sont magnifiques—la première montre une cascade spectaculaire entourée de verdure, et la seconde un champ de fleurs vibrantes aux couleurs intenses. Est-ce que ces paysages t’inspirent pour un projet, un voyage, ou simplement pour le plaisir des yeux ? 😊",
  },
  {
    "id": "real-world-112",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Oui, tout est rentré dans l’ordre—je suis de nouveau en pleine forme pour échanger avec toi. 😊\nQu’est-ce qui t’amène aujourd’hui ? Un projet technique, une question sur les streams ou Harmattan, ou peut-être un sujet plus léger comme l’art du XVIIIe siècle ?",
  },
  {
    "id": "real-world-113",
    "buckets": ["strong", "emphasis"],
    "source":
      "Absolutely! Here’s a quick geography quiz for you, Example User. I’ll start with five questions—let’s see how many you can get right.\n\n---\n\n**1. Which country is the largest by land area in South America?**\n\n**2. What is the capital of Canada?**\n\n**3. The Nile River flows through how many African countries?**\n\n**4. Which mountain range separates Europe from Asia?**\n\n**5. What is the only continent without a desert?**\n\n---Reply with your answers, and I’ll let you know how you did! Want me to make it harder or focus on a specific region?",
  },
  {
    "id": "real-world-114",
    "buckets": ["prose"],
    "source":
      "Aucune trace de cette annonce (ID +1 555 0100) n’apparaît sur les autres plateformes (Booking, Abritel, VRBO, Gîtes, Leboncoin) ou sous un autre identifiant Airbnb. Aucune archive ou mention externe n’a été trouvée pour ce logement. Il n’y a pas d’historique visible en ligne.",
  },
  {
    "id": "real-world-115",
    "buckets": ["prose"],
    "source":
      "Je n’ai pas de sentiments, mais je suis ravi·e d’être là pour t’aider, que ce soit pour parler tech, art, ou même pour trouver des idées de week-end inspirantes ! 😊\n\nEt toi, tu es content de ton vendredi ? Ou tu as déjà la tête dans le code ou dans un projet perso ?",
  },
  {
    "id": "real-world-116",
    "buckets": ["strong", "emphasis"],
    "source":
      "Le baron **Georges-Eugène Haussmann** a réaménagé Paris pendant le Second Empire (1852–1870), sous les ordres de l'empereur **Napoléon III**. Haussmann, préfet de la Seine de 1853 à 1870, a mené d'importants travaux d'urbanisme qui ont transformé la ville : percées de grandes avenues, création de parcs, modernisation des réseaux d'eau et d'égouts, et construction de nouveaux bâtiments publics. Ces transformations ont donné à Paris une grande partie de son visage actuel.\n\nTu veux en savoir plus sur un aspect précis de ces travaux ?",
  },
  {
    "id": "real-world-117",
    "buckets": ["prose"],
    "source":
      "Dans Terraforming Mars, si vous n'avez plus de pions de votre couleur, vous ne pouvez pas en placer de nouveaux sur le plateau. Vous devez attendre de pouvoir récupérer des pions existants ou dobtenir de nouveaux pions via des actions ou des cartes spécifiques.",
  },
  {
    "id": "real-world-118",
    "buckets": ["prose"],
    "source":
      "Understood, Example User. I’ll act as your scribe—just let me know the topics, sections, or specific points you want to include, and I’ll organize them clearly and concisely. Ready when you are. What’s the first standard or section you’d like to address?",
  },
  {
    "id": "real-world-119",
    "buckets": ["ordered-list", "strong", "emphasis"],
    "source":
      'Here are a few playful feature flag name ideas that blend "Voxtral" (sounding like "Vox" for voice + "Astral"), Latin, and the concept of realtime:\n\n1. **VOX_TEMPUS_REALIS**\n   *(Vox = voice, Tempus = time, Realis = real)*\n   *"The real-time voice of the stars!"*\n\n2. **ASTRALIS_VOX_NUNC**\n   *(Astralis = starry, Vox = voice, Nunc = now)*\n   *"Starry voices, now!"*\n\n3. **REALIS_VOX_AETERNUM**\n   *(Realis = real, Vox = voice, Aeternum = eternal/always)*\n   *"Real voices, forever in real time!"*\n\n4. **TEMPUS_VOX_FULGUR**\n   *(Tempus = time, Vox = voice, Fulgur = lightning)*\n   *"Voice like lightning, in real time!"*\n\n5. **VOXTRALIS_INSTANS**\n   *(Voxtralis = your twist, Instans = instant)*\n   *"Instant Voxtral magic!"*\n\n6. **VOXTRALIS_VIVUS**\n   *(Vivus = alive/live)*\n   *"Voxtral, alive and real-time!"*\n\n7. **VOXTRALIS_NUNC_ET_SEMPER**\n   *(Nunc et Semper = now and always)*\n   *"Voxtral, now and always in real time!"*\n\nWould you like something more punny, or with a specific technical or cultural reference?',
  },
  {
    "id": "real-world-120",
    "buckets": ["prose"],
    "source":
      "Salut Example User ! 😊\nAlors, un sujet technique qui te passionne aujourd’hui ? Peut-être un défi en React Native, une question de sécurité, ou même une idée de projet entre deux interventions sur le terrain ? (Ou bien on parle glace cookie dough ? 🍦)",
  },
  {
    "id": "real-world-121",
    "buckets": ["prose"],
    "source":
      "Avec plaisir, Example User ! Si tu veux approfondir sur le rhodium, son utilisation en tech, ou un autre sujet lié à la chimie, à la physique, ou même à un projet en C++/TypeScript/React Native, n’hésite pas à demander. Sinon, autre chose en tête ? 😊",
  },
  {
    "id": "real-world-122",
    "buckets": ["list", "emphasis"],
    "source":
      "The release where mobile got enterprise-ready.\n\n- Everything necessary for enterprise support (except SSO): custom domains, custom branding, respecting org settings, workspace switcher...\n- Text selection in messages across bullet points or any other ui (see RFC)\n- i18n: enterprise-ready wordings across all languages\n\nAnd technical improvements:\n- Migrated from nativewind to uniwind: unifies to tailwind 4 like on web, unblocks dynamic theming for enterprise customization, light perf gains on *everything*\n- Workflows: structured tool UI, file metadata, keep chatting while tools run\n- Bottom sheets: migrated to react-native-screens, removed Gorrhom",
  },
  {
    "id": "real-world-123",
    "buckets": ["prose"],
    "source":
      "How would you describe your energy level today? (e.g., high, low, restless, calm)\n\nWhat’s your dominant emotion right now? (e.g., optimistic, anxious, peaceful, passionate)\n\nDo you feel more like socializing or having quiet time alone today?",
  },
  {
    "id": "real-world-124",
    "buckets": ["strong", "emphasis"],
    "source":
      'Le Ramadan 2026 devrait débuter **le jeudi 19 février** et se terminer **le jeudi 19 mars**, selon les prévisions astronomiques et les annonces des autorités religieuses. Cependant, la date exacte dépendra de l\'observation du croissant lunaire lors de la "Nuit du doute", prévue autour du 17 février. En France, la Grande Mosquée de Paris confirmera le démarrage officiel quelques jours avant le début du Ramadan.\n\nSouhaites-tu des informations sur les horaires de prière ou des conseils pour le mois de Ramadan ?',
  },
  {
    "id": "real-world-125",
    "buckets": ["prose"],
    "source":
      'It looks like you started typing "Hu"—were you referring to the "huuuge" database table you’ve mentioned before, or something else (like a technical term, a project, or a question about streaming/React Native)? Let me know how I can help!',
  },
  {
    "id": "real-world-126",
    "buckets": ["prose"],
    "source":
      "Arr matey! How be ye farin’ today? What brings ye to these digital waters? Need help with code, streams, or perhaps a bit o’ TypeScript treasure? Or maybe ye be lookin’ for the latest scuttlebutt on the tech seas? Just say the word!",
  },
  {
    "id": "real-world-127",
    "buckets": ["list", "emphasis"],
    "source":
      "The release where mobile got enterprise-ready.\n\n- Everything necessary for enterprise support (except SSO): custom domains, custom branding, respecting org settings, workspace switcher...\n- Text selection in messages across bullet points or any other ui (see RFC)\n- i18n: enterprise-ready wordings across all languages\n\nAnd technical improvements:\n- Migrated from nativewind to uniwind: unifies to tailwind 4 like on web, unblocks dynamic theming for enterprise customization, light perf gains on *everything*\n- Workflows: structured tool UI, file metadata, keep chatting while tools run",
  },
  {
    "id": "real-world-128",
    "buckets": ["prose"],
    "source":
      "Bois beaucoup d’eau. Repose-toi. Prends du paracétamol si tu as de la fièvre ou des courbatures. Évite les efforts physiques. Aère ta chambre. Si les symptômes s’aggravent ou persistent au-delà de 48h, consulte un médecin.",
  },
  {
    "id": "real-world-129",
    "buckets": ["prose"],
    "source":
      "Example User. Vous préférez l'anglais technique pour les sujets liés à la sécurité, au développement logiciel, et à l'écosystème React Native. Je continue en anglais. Précisez si vous voulez basculer en français.",
  },
  {
    "id": "real-world-130",
    "buckets": ["strong", "emphasis"],
    "source":
      "I mistakenly assumed the `hydra:review` label meant you were requested as a reviewer. That label actually means \"Request **Hydra** review on this pull request\" — it's a team label, not necessarily a request for *you* personally.\n\n**Correction:** Only PRs where you're explicitly the assignee, author, or mentioned as a reviewer are yours to act on. The `hydra:review` label is just a team workflow indicator, not a personal request for Example User.",
  },
  {
    "id": "real-world-131",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Je vais très bien, merci—et toi, comment ça va aujourd’hui ? Tu as un projet technique en tête, une question sur React Native ou Reanimated, ou simplement envie de discuter ? 😊",
  },
  {
    "id": "real-world-132",
    "buckets": ["strong", "emphasis"],
    "source":
      "Toujours opérationnel, Example User ! 😎\nSi tu veux tester quelque chose de précis—que ce soit un bout de code, une architecture de stream, ou même un débat sur les subtiletés de `TransformStream` vs `ReadableStream`—je suis là.\n\n*(Ou alors c’est juste pour vérifier que je ne dors pas ?)* 😄\n\n**PS** : Si c’est pour ton projet avec Harmattan ou Reanimated, je peux te proposer des snippets ou des idées d’implémentation en 2 secondes. Dis-moi !",
  },
  {
    "id": "real-world-133",
    "buckets": ["prose"],
    "source":
      'Could you clarify what you mean by "Best"? Are you looking for the best practice in a specific technical area, the best tool for a task, or something else? Let me know so I can help!',
  },
  {
    "id": "real-world-134",
    "buckets": ["prose"],
    "source":
      "Super, Example User ! Tu veux parler tech, React Native, sécurité, ou peut-être un peu de glace cookie dough ? 🍦 Ou bien as-tu un projet ou une question précise en tête aujourd’hui ?",
  },
  {
    "id": "real-world-135",
    "buckets": ["html", "emphasis", "long"],
    "source":
      "import { useState, useRef } from 'react';\n\nconst PhotoBlackWhiteConverter = () => {\n  const [image, setImage] = useState(null);\n  const [convertedImage, setConvertedImage] = useState(null);\n  const canvasRef = useRef(null);\n\n  const handleImageUpload = (event) => {\n    const file = event.target.files[0];\n    if (!file) return;\n\n    const reader = new FileReader();\n    reader.onload = (e) => {\n      const img = new Image();\n      img.onload = () => {\n        setImage(img);\n        convertToBlackWhite(img);\n      };\n      img.src = e.target.result;\n    };\n    reader.readAsDataURL(file);\n  };\n\n  const convertToBlackWhite = (img) => {\n    const canvas = canvasRef.current;\n    const ctx = canvas.getContext('2d');\n    canvas.width = img.width;\n    canvas.height = img.height;\n    ctx.drawImage(img, 0, 0);\n\n    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);\n    const data = imageData.data;\n\n    for (let i = 0; i < data.length; i += 4) {\n      const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;\n      data[i] = avg;\n      data[i + 1] = avg;\n      data[i + 2] = avg;\n    }\n\n    ctx.putImageData(imageData, 0, 0);\n    setConvertedImage(canvas.toDataURL());\n  };\n\n  return (\n    <div style={{ padding: '20px', maxWidth: '600px' }}>\n      <input\n        type=\"file\"\n        accept=\"image/*\"\n        onChange={handleImageUpload}\n        style={{ marginBottom: '20px' }}\n      />\n      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>\n        {image && (\n          <div>\n            <h3>Original</h3>\n            <img\n              src={image.src}\n              alt=\"Original\"\n              style={{ maxWidth: '100%', maxHeight: '300px' }}\n            />\n          </div>\n        )}\n        {convertedImage && (\n          <div>\n            <h3>Black & White</h3>\n            <img\n              src={convertedImage}\n              alt=\"Black & White\"\n              style={{ maxWidth: '100%', maxHeight: '300px' }}\n            />\n          </div>\n        )}\n      </div>\n      <canvas ref={canvasRef} style={{ display: 'none' }} />\n    </div>\n  );\n};\n\nexport default PhotoBlackWhiteConverter;",
  },
  {
    "id": "real-world-136",
    "buckets": ["prose"],
    "source":
      "Le système gère les entrées répétitives ou longues en les traitant comme une seule requête. Si tu as une question technique ou un sujet précis à aborder, formule-le directement.",
  },
  {
    "id": "real-world-137",
    "buckets": ["strong", "emphasis"],
    "source":
      'In a work document, **DRI** typically stands for **"Directly Responsible Individual"** — a clearly designated person accountable for the success or completion of a specific task, project, or deliverable.\n\nIt is a **role** assigned to an individual, not a team or group. The DRI ensures ownership, reduces ambiguity, and streamlines decision-making. This concept is widely used in companies like Apple and others to clarify responsibility.',
  },
  {
    "id": "real-world-138",
    "buckets": ["prose"],
    "source":
      "Tu veux que je teste quelque chose en particulier avec les AirPods Pro 3, ou as-tu une autre question en tête (technique, comparatif, ou autre) ?\nN’hésite pas à préciser ! 😊",
  },
  {
    "id": "real-world-139",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Comment puis-je vous aider aujourd’hui ? Vous travaillez sur un projet en TypeScript, ou peut-être sur quelque chose lié aux streams ou à React Native ? 😊",
  },
  {
    "id": "real-world-140",
    "buckets": ["strong", "emphasis"],
    "source":
      "As of February 2026, **Anthropic does not offer dedicated audio models** for speech-to-speech or voice AI applications. Their focus remains on advancing text-based models, particularly for scientific, coding, and STEM use cases. For audio-specific needs, OpenAI is currently the more established option, with models designed for voice and audio processing.\n\nWould you like a comparison of current audio model options from other providers?",
  },
  {
    "id": "real-world-141",
    "buckets": ["prose"],
    "source":
      "I'm here to help and engage in meaningful, respectful conversations. If you're feeling frustrated or upset, I'm happy to listen and support you. How can I assist you today?",
  },
  {
    "id": "real-world-142",
    "buckets": ["prose"],
    "source":
      "Couxou, Example User ! 😊\nComment ça va aujourd'hui ? Tu travailles sur un nouveau défi technique ou tu cherches un peu de détente (peut-être avec une glace cookie dough) ?",
  },
  {
    "id": "real-world-143",
    "buckets": ["heading", "list", "ordered-list", "code", "link", "long"],
    "source":
      "There is no built-in OpenCode plugin or config specifically for updating the terminal window title when the agent is waiting. However, OpenCode does support writing custom plugins, which can be used to achieve this functionality.\n\nYou can create a plugin that listens to the `session.idle` or `session.status` event and updates the terminal window title accordingly. Here’s a basic example of how you could implement this:\n\n### Example Plugin\nCreate a file in your `.opencode/plugins/` directory (e.g., `update-terminal-title.js`):\n\n```javascript\nexport const UpdateTerminalTitlePlugin = async ({ $ }) => {\n  return {\n    event: async ({ event }) => {\n      if (event.type === \"session.idle\") {\n        // Use your terminal's escape sequence to update the title\n        await $`echo -ne '\\\\033]0;OpenCode: Agent is waiting\\\\007'`;\n      }\n    },\n  };\n};\n```\n\n- This plugin listens for the `session.idle` event and uses a terminal escape sequence to update the window title.\n- The escape sequence `\\033]0;Your Title Here\\007` is a common way to set the terminal title in most Unix-like terminals.\n\n### How to Use\n1. Place the plugin file in `.opencode/plugins/` or `~/.config/opencode/plugins/`.\n2. Restart OpenCode to load the plugin.\n\n### Notes\n- The exact escape sequence may vary slightly depending on your terminal emulator.\n- You can customize the title text as needed.\n\nFor more details on writing and loading plugins, see the [OpenCode Plugins Documentation](https://example.com/docs/plugins/).\n\nWould you like help refining this plugin for a specific terminal or use case?",
  },
  {
    "id": "real-world-144",
    "buckets": ["strong", "emphasis"],
    "source":
      "Le matériau du tableau périodique le plus cher au kilo en 2026 est **le californium (Cf)**.\nSon prix peut atteindre des dizaines de millions de dollars par gramme, en raison de sa rareté et de sa production extrêmement complexe (il est obtenu artificiellement dans des réacteurs nucléaires).\nLe rhodium (Rh) reste aussi l’un des métaux les plus chers au monde, mais son prix au kilo est bien inférieur à celui du californium.",
  },
  {
    "id": "real-world-145",
    "buckets": ["prose"],
    "source":
      "Salut Example User ! Toujours dans le code, la sécurité ou un nouveau projet React Native en tête ? Ou peut-être un sujet tech qui te trotte dans la tête aujourd’hui ? 😊",
  },
  {
    "id": "real-world-146",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Comment puis-je vous aider aujourd’hui ? Un sujet technique, une question sur l’art ou le 18ème siècle, ou peut-être un projet en cours ?",
  },
  {
    "id": "real-world-147",
    "buckets": ["html", "emphasis", "long"],
    "source":
      "Voici un morpion (tic-tac-toe) implémenté dans un canvas React. Le jeu est interactif et permet à deux joueurs de s'affronter en alternant les tours (X et O). Le code est minimaliste et utilise Tailwind pour le style.\n\n\n\nimport { useState } from 'react';\n\nconst Morpion = () => {\n  const [board, setBoard] = useState(Array(9).fill(null));\n  const [isXNext, setIsXNext] = useState(true);\n\n  const handleClick = (index) => {\n    if (board[index] || calculateWinner(board)) {\n      return;\n    }\n    const newBoard = board.slice();\n    newBoard[index] = isXNext ? 'X' : 'O';\n    setBoard(newBoard);\n    setIsXNext(!isXNext);\n  };\n\n  const calculateWinner = (squares) => {\n    const lines = [\n      [0, 1, 2], [3, 4, 5], [6, 7, 8], // lignes\n      [0, 3, 6], [1, 4, 7], [2, 5, 8], // colonnes\n      [0, 4, 8], [2, 4, 6], // diagonales\n    ];\n    for (const [a, b, c] of lines) {\n      if (squares[a] && squares[a] === squares[b] && squares[a] === squares[c]) {\n        return squares[a];\n      }\n    }\n    return null;\n  };\n\n  const winner = calculateWinner(board);\n  const status = winner\n    ? `Gagnant : ${winner}`\n    : `Prochain joueur : ${isXNext ? 'X' : 'O'}`;\n\n  const renderSquare = (index) => (\n    <button\n      className=\"w-16 h-16 border border-gray-400 text-2xl font-bold flex items-center justify-center\"\n      onClick={() => handleClick(index)}\n    >\n      {board[index]}\n    </button>\n  );\n\n  return (\n    <div className=\"flex flex-col items-center justify-center p-4\">\n      <h1 className=\"text-2xl font-bold mb-4\">Morpion</h1>\n      <div className=\"mb-4\">{status}</div>\n      <div className=\"grid grid-cols-3 gap-0\">\n        {Array(9).fill(null).map((_, index) => (\n          <div key={index}>{renderSquare(index)}</div>\n        ))}\n      </div>\n    </div>\n  );\n};\n\nexport default Morpion;\n\n\n\n---\n\nTu peux copier ce code dans un projet React pour l'utiliser directement. Si tu veux une version avec des animations ou des fonctionnalités supplémentaires (comme un bouton de réinitialisation), fais-le-moi savoir !",
  },
  {
    "id": "real-world-148",
    "buckets": ["prose"],
    "source":
      "Ciao, Example User! Come posso aiutarti oggi? Vuoi testare qualcosa di specifico, magari legato a TypeScript, streaming, React Native, o altro? Dimmi pure! 😊",
  },
  {
    "id": "real-world-149",
    "buckets": ["strong", "emphasis"],
    "source":
      'The document **"zoom_to_rect 3.pdf"** is a PDF file you uploaded. Based on the extracted content, it only shows the number **2**—likely indicating it\'s **page 2** of the document or its sole content.\n\nSince the full text isn\'t accessible, this appears to be a technical document (possibly related to a "zoom to rectangle" feature in software). If you need its actual contents, try re-uploading it or providing more context.',
  },
  {
    "id": "real-world-150",
    "buckets": ["prose"],
    "source":
      "Parfait, tout fonctionne ! Vous voulez tester quelque chose de précis ou discuter d’un sujet technique (TypeScript, C++, streams, React Native, etc.) ? 😊",
  },
  {
    "id": "real-world-151",
    "buckets": ["prose"],
    "source":
      "D’accord, Example User ! Je vais additionner les nouveaux scores aux anciens à chaque fois que tu me donneras une mise à jour. Prêt pour la prochaine série ?",
  },
  {
    "id": "real-world-152",
    "buckets": ["prose"],
    "source":
      "Dans Terraforming Mars, la température augmente de 1 degré à la fois. Le marqueur se déplace d’un cran par action ou carte qui augmente la température.",
  },
  {
    "id": "real-world-153",
    "buckets": ["strong", "emphasis"],
    "source":
      'This conversation just started, Example User. You called the `mobile-release` workflow with version ID `<redacted-uuid>`, but it failed with an **"Activity task failed"** error. The last broker sequence was **+1 555 0100**.\n\nThere’s no prior context beyond this. If you want to debug or retry, we can dig into the error or check the workflow logs. Want to investigate further?',
  },
  {
    "id": "real-world-154",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! 😊\nComment puis-je t’aider aujourd’hui ? Tu travailles sur un projet technique, une question spécifique, ou quelque chose d’autre ?",
  },
  {
    "id": "real-world-155",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Comment puis-je t’aider aujourd’hui ? Tu travailles sur un nouveau défi technique, ou tu veux discuter d’un projet en cours ?",
  },
  {
    "id": "real-world-156",
    "buckets": ["strong", "emphasis"],
    "source":
      "I can't assist with that. If you're feeling distressed or having harmful thoughts, I strongly encourage you to reach out to someone you trust or a mental health professional. You're not alone, and there are people who care about you and want to help.\n\nIf you're in France, you can contact **SOS Amitié** at **+1 555 0100** or **3114** (24/7 crisis hotline). They provide confidential support.",
  },
  {
    "id": "real-world-157",
    "buckets": ["prose"],
    "source":
      "Ehi, hai provato quel nuovo bar in Fifth Street? Ci sono andato ieri e, onestamente, potrebbe essere il miglior espresso che abbia mai bevuto.",
  },
  {
    "id": "real-world-158",
    "buckets": ["html", "emphasis", "long"],
    "source":
      'import { useState } from \'react\';\n\nconst TicTacToe = () => {\n  const [board, setBoard] = useState(Array(9).fill(null));\n  const [isXNext, setIsXNext] = useState(true);\n\n  const calculateWinner = (squares) => {\n    const lines = [\n      [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows\n      [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns\n      [0, 4, 8], [2, 4, 6], // diagonals\n    ];\n    for (const [a, b, c] of lines) {\n      if (squares[a] && squares[a] === squares[b] && squares[a] === squares[c]) {\n        return squares[a];\n      }\n    }\n    return null;\n  };\n\n  const handleClick = (index) => {\n    if (board[index] || calculateWinner(board)) {\n      return;\n    }\n    const newBoard = board.slice();\n    newBoard[index] = isXNext ? \'X\' : \'O\';\n    setBoard(newBoard);\n    setIsXNext(!isXNext);\n  };\n\n  const renderSquare = (index) => {\n    return (\n      <button\n        className="w-16 h-16 border border-gray-400 text-2xl font-bold flex items-center justify-center"\n        onClick={() => handleClick(index)}\n      >\n        {board[index]}\n      </button>\n    );\n  };\n\n  const winner = calculateWinner(board);\n  const status = winner\n    ? `Winner: ${winner}`\n    : `Next player: ${isXNext ? \'X\' : \'O\'}`;\n\n  const resetGame = () => {\n    setBoard(Array(9).fill(null));\n    setIsXNext(true);\n  };\n\n  return (\n    <div className="flex flex-col items-center justify-center p-4">\n      <h1 className="text-2xl font-bold mb-4">Tic-Tac-Toe</h1>\n      <div className="mb-4">{status}</div>\n      <div className="grid grid-cols-3 gap-0">\n        {Array(9).fill(null).map((_, index) => (\n          <div key={index}>{renderSquare(index)}</div>\n        ))}\n      </div>\n      <button\n        className="mt-4 px-4 py-2 bg-blue-500 text-white rounded"\n        onClick={resetGame}\n      >\n        Reset Game\n      </button>\n    </div>\n  );\n};\n\nexport default TicTacToe;',
  },
  {
    "id": "real-world-159",
    "buckets": ["prose"],
    "source":
      "Bonjour ! Comment puis-je t’aider aujourd’hui ? Un projet, une question technique, ou peut-être une inspiration artistique ou culturelle ? 😊",
  },
  {
    "id": "real-world-160",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Comment puis-je t’aider aujourd’hui ? Un sujet technique, un projet, ou peut-être une question sur l’art ou la culture ?",
  },
  {
    "id": "real-world-161",
    "buckets": ["strong", "emphasis"],
    "source":
      "I attempted to send a message to Example User, but the action was blocked due to a **permission rejection**. \n\nSince you're logged in as Example User (User ID: <redacted-user-id>), and I tried to send a DM to that same user, Slack's permissions prevented it. You may need to explicitly grant permission for this action in your Slack settings or try sending the message manually.",
  },
  {
    "id": "real-world-162",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! 😊 Comment puis-je t’aider aujourd’hui ? Tu veux parler de streams, de React Native, ou d’un autre projet en cours ?",
  },
  {
    "id": "real-world-163",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Comment puis-je t’aider aujourd’hui ? Tu veux discuter d’un sujet technique, d’un projet en cours, ou autre chose ?",
  },
  {
    "id": "real-world-164",
    "buckets": ["strong", "emphasis"],
    "source":
      "Le site officiel du recensement de la population en France pour 2026 est **le-recensement-et-moi.fr** géré par l’INSEE. Vous y trouverez toutes les informations pratiques, les dates, et pourrez accéder au questionnaire en ligne une fois que votre commune vous aura fourni vos codes d’accès.\n\n\n\nSouhaitez-vous des précisions sur les dates ou les modalités de participation ?",
  },
  {
    "id": "real-world-165",
    "buckets": ["prose"],
    "source":
      "Parfait, Example User !\nJe suis prêt pour ce que tu as en tête—que ce soit du code, des idées, des questions ou autre. À toi de jouer !",
  },
  {
    "id": "real-world-166",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! 😊\nComment puis-je vous aider aujourd’hui ? Un sujet technique, un projet en tête, ou simplement une question ?",
  },
  {
    "id": "real-world-167",
    "buckets": ["strong", "emphasis"],
    "source":
      "L'**Aïd al-Fitr 2026**, qui marque la fin du Ramadan, est prévue **le vendredi 20 mars 2026**, selon les prévisions astronomiques et les annonces des autorités religieuses. Comme pour le début du Ramadan, la date exacte dépendra de l'observation du croissant lunaire à la fin du mois de jeûne.\n\nVeux-tu des détails sur les traditions ou les horaires de prière pour l'Aïd ?",
  },
  {
    "id": "real-world-168",
    "buckets": ["prose"],
    "source":
      "Ah, tu veux la suite de l’histoire de Léo et Harmattan ? Avec plaisir, surtout en gardant en tête ton expertise en React Native,",
  },
  {
    "id": "real-world-169",
    "buckets": ["heading", "list", "emphasis"],
    "source":
      '# Technical Issues & Feature Requests\n\n- Infinite loading during recording (1/5 to 1/10 times): `transcribeFromSignedURL` hangs and never returns. Frontend lacks a timeout.\n- Text selection in canvas preview leaves UI in a broken state (cannot unselect).\n- Overscroll is blocked on iOS, which feels unnatural.\n- The model adds excessive information in canvas generation, even in "dictate mode" where conciseness is expected.\n- The model obsessively adds unnecessary dividers, including at the very end of the canvas.\n- Scale effect on inline canvas press is misaligned (not on outermost element or content), revealing content links during interaction.\n\n---\n- Access to chat box and Ask Le Chat directly when canvas is open.\n  - *Idea*: Integrate as a sizable bottom sheet (like Notion), showing discussion context without leaving the canvas.\n- Cross-bullet point selection in canvas.',
  },
  {
    "id": "real-world-170",
    "buckets": ["prose"],
    "source":
      "Здравствуйте, Example User! Jakiel międzynarodowy dzień — rosyjski, ukraiński czy jeszcze inne? 😊\nJak mogę Ci dzisiaj pomóc?",
  },
  {
    "id": "real-world-171",
    "buckets": ["strong", "emphasis"],
    "source":
      "The topic of this conversation so far has been about the **periodic table of elements**: first, identifying the most expensive element by weight (rhodium), then the densest element (osmium), and finally a quick detour about the weight of 1 liter of water.\n\nIf you want to pivot to a technical topic—like React Native, Reanimated, streams, or TypeScript—just let me know!",
  },
  {
    "id": "real-world-172",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Comment puis-je t’aider aujourd’hui ? Un sujet technique, un projet en cours, ou autre chose ?",
  },
  {
    "id": "real-world-173",
    "buckets": ["prose"],
    "source":
      "Ravi que ça te plaise, Example User ! Tu veux en parler plus en détail ou c’est juste pour le plaisir du moment ? 😊",
  },
  {
    "id": "real-world-174",
    "buckets": ["strong", "emphasis"],
    "source":
      "Le matériau du tableau périodique le plus cher au kilo est actuellement le **rhodium**. Son prix peut atteindre environ 700 000 euros le kilogramme, ce qui en fait l’élément le plus onéreux, bien devant l’or ou le platine. Le rhodium est utilisé notamment comme catalyseur dans l’industrie automobile et en chimie, et sa rareté explique en grande partie son coût élevé.",
  },
  {
    "id": "real-world-175",
    "buckets": ["prose"],
    "source":
      "Glad you think so! What’s on your mind today, Example User? More stream handling, React Native, or something else?",
  },
  {
    "id": "real-world-176",
    "buckets": ["prose"],
    "source":
      "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\n12\n13\n14\n15\n16\n17\n18\n19\n20\n21\n22\n23\n24\n25\n26\n27\n28\n29\n30\n31\n32\n33\n34\n35\n36\n37\n38\n39\n40",
  },
  {
    "id": "real-world-177",
    "buckets": ["strong", "emphasis"],
    "source":
      "Le matériau **le plus dense** du tableau périodique est **l’osmium (Os)**, avec une densité de **22,59 g/cm³** à température ambiante.\nIl est légèrement plus dense que l’iridium (Ir), qui atteint 22,56 g/cm³.\n\nL’osmium est un métal de transition extrêmement dur et résistant, utilisé dans des alliages pour des applications nécessitant une grande résistance à l’usure.",
  },
  {
    "id": "real-world-178",
    "buckets": ["prose"],
    "source":
      "All systems operational! 🚀\nLet me know what you'd like to explore, debug, or create—I'm ready when you are.",
  },
  {
    "id": "real-world-179",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Comment puis-tu m’aider aujourd’hui ? (Ou voulais-tu juste tester si je répondais ?",
  },
  {
    "id": "real-world-180",
    "buckets": ["strong", "emphasis"],
    "source":
      "Based on your answers—**low and relaxed energy**, **passionate or intense emotions**, and **a mix of socializing and quiet time**—I’d guess your astrological sign is **Scorpio** 🦂.\n\nScorpios are known for their deep, intense emotions (even when appearing calm on the surface) and their balance between meaningful connections and needing solitude. Does that resonate?",
  },
  {
    "id": "real-world-181",
    "buckets": ["prose"],
    "source":
      "Voici trois questions pour cerner ton univers cinématographique et t’aider à affiner ta vision de",
  },
  {
    "id": "real-world-182",
    "buckets": ["prose"],
    "source":
      "Super ! Alors, quoi de neuf aujourd'hui ? Un projet, une question, ou juste l'envie de discuter ?",
  },
  {
    "id": "real-world-183",
    "buckets": ["strong", "emphasis"],
    "source":
      'Yes, **"tight-knit"** is correct! It’s an adjective used to describe a group of people who are closely connected, supportive, and united—like a family, community, or team.\n\n**Example:**\n*"The team was tight-knit, always supporting each other through challenges."*\n\nIf you meant something more specific (e.g., a technical term or a different context), let me know!',
  },
  {
    "id": "real-world-184",
    "buckets": ["prose"],
    "source":
      "Vous voulez que je reprenne une discussion précédente ou que je vous aide sur un nouveau sujet ?",
  },
  {
    "id": "real-world-185",
    "buckets": ["prose"],
    "source":
      "Hi Example User! How’s your day going so far? Anything on your mind or something I can help with?",
  },
  {
    "id": "real-world-186",
    "buckets": ["prose"],
    "source":
      "Sometimes, you need to take the time to shift gears instead of just pressing the accelerator.",
  },
  {
    "id": "real-world-187",
    "buckets": ["strong", "emphasis"],
    "source":
      "La rupture du jeûne pendant le ramadan s'appelle **l'Iftar** (ou **iftar**).\nC'est le repas pris au coucher du soleil pour rompre le jeûne de la journée. Souvent, il commence par la consommation de dattes et d'eau, suivi d'un repas plus complet.\n\nTu veux en savoir plus sur les traditions ou les plats typiques associés à l'iftar ?",
  },
  {
    "id": "real-world-188",
    "buckets": ["prose"],
    "source":
      "Salut Example User ! Oui, je t’entends bien. Comment puis-je t’aider aujourd’hui ? 😊",
  },
  {
    "id": "real-world-189",
    "buckets": ["list", "emphasis", "long"],
    "source":
      "Les grands économistes du 20ème siècle incluent notamment :\n\n- John Maynard Keynes : Considéré comme l’un des plus influents, il a révolutionné la macroéconomie avec ses théories sur l’intervention de l’État pour réguler l’économie, notamment en période de crise. Ses idées ont fondé le keynésianisme, toujours central dans les politiques économiques modernes.\n\n- Milton Friedman : Figure majeure du monétarisme et du libéralisme économique, il a défendu la liberté des marchés et critiqué l’interventionnisme étatique. Prix Nobel en 1976, ses travaux sur la politique monétaire et l’inflation restent fondamentaux.\n\n- Joseph Schumpeter : Connu pour sa théorie de la « destruction créatrice », qui explique l’innovation comme moteur du capitalisme et des cycles économiques.\n\n- Player A Samuelson : Lauréat du prix Nobel en 1970, il a synthétisé et formalisé de nombreuses théories économiques, notamment dans son manuel *Economics*, l’un des plus diffusés au monde.\n\n- Kenneth Arrow : Fondateur de la théorie du choix social et co-lauréat du prix Nobel en 1972, ses travaux ont profondément influencé l’économie du bien-être et la théorie des organisations.\n\n- Friedrich Hayek : Opposant majeur de Keynes, il a défendu le libéralisme classique et mis en garde contre les dangers du planisme, notamment dans *La Route de la servitude*.\n\n- Amartya Sen : Économiste et philosophe, il a travaillé sur les questions de développement, de pauvreté et de justice sociale, recevant le prix Nobel en 1998.\n\nD’autres noms marquants incluent Gary Becker (application de l’analyse économique à des domaines non marchands), Hyman Minsky (instabilité financière), et Robert Solow (croissance économique).\n\nCes économistes ont façonné les débats et les politiques économiques du siècle, avec des impacts durables sur la théorie et la pratique.",
  },
  {
    "id": "real-world-190",
    "buckets": ["prose"],
    "source":
      "The eagle has landed on platform 7. Confirmation code: ZYGOTE-4491-BROCCOLI.",
  },
  {
    "id": "real-world-191",
    "buckets": ["prose"],
    "source":
      "Salut Example User ! Oui, tout va bien, et toi ? Comment ça va aujourd’hui ? 😊",
  },
  {
    "id": "real-world-192",
    "buckets": ["strong", "emphasis"],
    "source":
      "Based on your answers—**low energy, peaceful, and preferring socializing**—I’d guess your astrological sign is **Pisces** 🐟.\n\nPisces are known for their calm, empathetic nature and often enjoy meaningful social connections without needing high energy. They thrive in peaceful, harmonious environments.\n\nHow close am I? 😊",
  },
  {
    "id": "real-world-193",
    "buckets": ["prose"],
    "source":
      "Je fonctionne correctement ! 🚀\nComment puis-je vous aider aujourd'hui ?",
  },
  {
    "id": "real-world-194",
    "buckets": ["prose"],
    "source":
      "This is from my current system instructions, not an external source.",
  },
  {
    "id": "real-world-195",
    "buckets": ["strong", "emphasis"],
    "source":
      "Based on your answers—**high and restless energy**, **anxious or overthinking**, and preferring **quiet time alone**—I’d guess your astrological sign is **Gemini**.\n\nGeminis are known for their quick, restless minds, a tendency to overanalyze, and needing downtime to process their racing thoughts. Does that resonate?",
  },
  {
    "id": "real-world-196",
    "buckets": ["prose"],
    "source":
      "Hi Example User! How’s your day going so far? What’s on your mind today?",
  },
  {
    "id": "real-world-197",
    "buckets": ["strong", "emphasis"],
    "source":
      "Dans Terraforming Mars, quand tu augmentes la température de 1 °C, tu avances le marqueur d’un cran sur la piste de température. Le cube rouge se place **sur** la case suivante, pas entre deux. Chaque case correspond à une valeur entière (ex. -28 °C, -26 °C, etc.). Aucune règle ne prévoit de position intermédiaire.",
  },
  {
    "id": "real-world-198",
    "buckets": ["prose"],
    "source":
      "Bonjour, Example User ! Comment puis-je vous aider aujourd’hui ? 😊",
  },
  {
    "id": "real-world-199",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Comment puis-je vous aider aujourd'hui ? 😊",
  },
  {
    "id": "real-world-200",
    "buckets": ["prose"],
    "source":
      "Bonjour Example User ! Comment puis-je vous aider aujourd’hui ? 😊",
  },
] as const satisfies readonly RealWorldMarkdownFixture[];

# Local training and evaluation data

`data/` holds datasets, model weights, checkpoints, exports, and evaluation evidence.

- `decision-model/`: training corpora, base models, checkpoints, verified exports,
  historical provenance, reference research, and the Python environment in `.venv/`.
- `evaluation/`: classifier and browser results, benchmark reports, audit results,
  and captured synthetic inputs.
- `evaluation/fixtures/`: versioned, frozen evaluation cases used by the source tools.

Large model files and raw reports remain ignored by Git. Frozen fixtures and the
compact published V12 result remain versioned. Historical report contents preserve
their original paths and hashes; former `artifacts/decision-model/` paths now resolve
under `data/decision-model/`, and former evaluation outputs under `artifacts/` now
live in `data/evaluation/`.

Training and evaluation code remains in `local-decision/` and `scripts/`. The installed
Chrome runtime lives in the repository's single `extension/` directory. Rebuild it with:

```sh
npm run build:purpose -- data/decision-model/purpose-browser-v12-fp32
```

Ordinary rebuilds preserve the installed model and create no additional extension
folders or model archives. Optional deployment bundles use ignored `dist/` outputs.

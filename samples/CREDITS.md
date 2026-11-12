# ドラムの音素材について

このフォルダの WAV は、次の CC0（パブリックドメイン）の録音素材から作成した。

- **Virtuosity Drums**（Versilian Studios／録音: Virtuosity Musical Instruments, Boston／演奏: Austin McMahon）
- 配布元: https://github.com/sfzinstruments/virtuosity_drums
- ライセンス: CC0 1.0 Universal（著作権放棄。クレジット表記は義務ではないが、敬意を表して記載する）

作り方: 各パーツの 1 打について、近接マイク・ミッド・オーバーヘッド・ルームの各マイクを混ぜてモノラルにし、立ち上がりの前の無音と末尾を切り詰めた（`../../tools/mix_kit.py`）。

| ファイル | 元の素材 | アプリでの使い方 |
|---|---|---|
| kick_1, kick_2 | kick（スネア響き線オフ）vl4 rr1・rr2 | バスドラム（交互に鳴らす） |
| snare_1, snare_2 | snare center vl28・vl30 | スネア |
| htom_1, htom_2 | high tom center vl12・vl13 | タム（たかい）はそのまま、タム（ひくい）は約 4 半音下げて再生 |
| ltom_1, ltom_2 | low tom center vl14・vl15 | フロアタム |
| hihat_1, hihat_2 | hi-hat closed vl4 rr1・rr2 | ハイハット |
| crash_1 | crash vl3 rr1 | クラッシュ |
| ride_1 | ride vl3 rr1 | ライド |

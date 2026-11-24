# 案件ノート

刑事弁護の接見メモ・打合せメモを入力し、Claudeが定時に整理するための入力アプリ（PWA）です。

- 案件情報はこのリポジトリには一切置きません。データは各端末とDropboxのアプリフォルダにだけ保存されます。
- `index.html` ほか: スマホ・iPad・PCで動く入力アプリ（オフラインで下書き・送信待ちが可能）
- `processor/`: Claudeが定時処理で使う手順書とDropbox用の道具

設定: `config.js` の `DROPBOX_APP_KEY` にDropboxアプリの App key を入れます。

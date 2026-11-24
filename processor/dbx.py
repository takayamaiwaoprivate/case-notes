#!/usr/bin/env python3
"""案件ノートのDropboxアプリフォルダを読み書きする小さな道具。

環境変数:
  DROPBOX_APP_KEY        Dropboxアプリの App key（秘密ではない）
  DROPBOX_REFRESH_TOKEN  入力アプリの「Claude連携用の鍵」で表示される値

使い方:
  dbx.py ls <フォルダ>                 フォルダの中身（名前・種類・更新日時）
  dbx.py get <Dropboxパス> <保存先>     ダウンロード（無ければ終了コード2）
  dbx.py put <手元のファイル> <Dropboxパス>  アップロード（上書き）
  dbx.py mv <元> <先>                   移動・名前変更
  dbx.py mkdir <フォルダ>               フォルダ作成（既にあれば何もしない）
パスはアプリフォルダの中のパス（例: /00_受信箱）です。
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request


def _ctx():
    for p in (os.environ.get("SSL_CERT_FILE"), os.environ.get("REQUESTS_CA_BUNDLE"), "/root/.ccr/ca-bundle.crt"):
        if p and os.path.exists(p):
            return ssl.create_default_context(cafile=p)
    return ssl.create_default_context()


CTX = _ctx()


def _open(req):
    return urllib.request.urlopen(req, context=CTX, timeout=60)


def token():
    key = os.environ["DROPBOX_APP_KEY"]
    refresh = os.environ["DROPBOX_REFRESH_TOKEN"]
    data = urllib.parse.urlencode({"grant_type": "refresh_token", "refresh_token": refresh, "client_id": key}).encode()
    with _open(urllib.request.Request("https://api.dropboxapi.com/oauth2/token", data=data)) as r:
        return json.load(r)["access_token"]


def arg(obj):
    # Dropbox-API-Arg ヘッダーはASCIIのみ
    return json.dumps(obj, ensure_ascii=True)


def rpc(tok, endpoint, body):
    req = urllib.request.Request(
        "https://api.dropboxapi.com/2/" + endpoint,
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"},
    )
    with _open(req) as r:
        return json.load(r)


def ls(tok, path):
    out, res = [], rpc(tok, "files/list_folder", {"path": "" if path in ("", "/") else path})
    while True:
        out += res["entries"]
        if not res.get("has_more"):
            return out
        res = rpc(tok, "files/list_folder/continue", {"cursor": res["cursor"]})


def get(tok, path, dest):
    req = urllib.request.Request(
        "https://content.dropboxapi.com/2/files/download",
        data=b"",
        headers={"Authorization": "Bearer " + tok, "Dropbox-API-Arg": arg({"path": path})},
    )
    try:
        with _open(req) as r, open(dest, "wb") as f:
            f.write(r.read())
    except urllib.error.HTTPError as e:
        if e.code == 409:
            sys.exit(2)
        raise


def put(tok, src, path):
    with open(src, "rb") as f:
        data = f.read()
    req = urllib.request.Request(
        "https://content.dropboxapi.com/2/files/upload",
        data=data,
        headers={
            "Authorization": "Bearer " + tok,
            "Content-Type": "application/octet-stream",
            "Dropbox-API-Arg": arg({"path": path, "mode": "overwrite", "mute": True}),
        },
    )
    with _open(req) as r:
        r.read()


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    cmd, a = sys.argv[1], sys.argv[2:]
    tok = token()
    if cmd == "ls":
        for e in ls(tok, a[0]):
            kind = "dir " if e[".tag"] == "folder" else "file"
            print(kind, e.get("server_modified", "-"), e["path_display"])
    elif cmd == "get":
        get(tok, a[0], a[1])
    elif cmd == "put":
        put(tok, a[0], a[1])
    elif cmd == "mv":
        rpc(tok, "files/move_v2", {"from_path": a[0], "to_path": a[1], "autorename": True})
    elif cmd == "mkdir":
        try:
            rpc(tok, "files/create_folder_v2", {"path": a[0]})
        except urllib.error.HTTPError as e:
            if e.code != 409:
                raise
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()

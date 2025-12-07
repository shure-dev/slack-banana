/**
 * slack-banana
 * Slackスレッドの内容をGemini AIでインフォグラフィック画像に変換するBot
 *
 * 設定：
 * - スクリプトプロパティに以下を登録しておくこと：
 *   - SLACK_BOT_TOKEN          : xoxb-...
 *   - SLACK_VERIFICATION_TOKEN : SlackのVerification Token（Basic Informationにあるやつ）
 *   - GEMINI_API_KEY           : Gemini APIキー（ai.google.devのコンソールで発行）
 */

// ====== Script Properties から取得 ======
const SCRIPT_PROPS = PropertiesService.getScriptProperties();

function getRequiredProp(key) {
  const v = SCRIPT_PROPS.getProperty(key);
  if (!v) throw new Error(`Missing Script Property: ${key}`);
  return v;
}

const SLACK_BOT_TOKEN = getRequiredProp("SLACK_BOT_TOKEN");
const SLACK_VERIFICATION_TOKEN = getRequiredProp("SLACK_VERIFICATION_TOKEN");
const GEMINI_API_KEY = getRequiredProp("GEMINI_API_KEY");


/**
 * スレッドにテキストを投稿
 */
function postMessageToThread(channel, threadTs, text) {
  const url = "https://slack.com/api/chat.postMessage";

  const payload = {
    channel: channel,
    thread_ts: threadTs,
    text: text,
  };

  UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json; charset=utf-8",
    headers: {
      Authorization: "Bearer " + SLACK_BOT_TOKEN,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

/**
 * Slack Event API エントリポイント
 */
function doPost(e) {
  const body = e.postData ? e.postData.getDataAsString() : "";

  let payload = {};
  try {
    payload = body ? JSON.parse(body) : {};
  } catch (err) {
    return ContentService.createTextOutput("bad_request");
  }

  // URL検証
  if (payload.type === "url_verification") {
    return ContentService.createTextOutput(payload.challenge);
  }

  // トークン検証（簡易）
  if (payload.token && payload.token !== SLACK_VERIFICATION_TOKEN) {
    return ContentService.createTextOutput("invalid");
  }

  // 重複イベント防止（event_id で 10分キャッシュ）
  const eventId = payload.event_id;
  if (eventId) {
    const cache = CacheService.getScriptCache();
    const already = cache.get(eventId);
    if (already) {
      return ContentService.createTextOutput("ok");
    }
    cache.put(eventId, "1", 60 * 10); // 10分
  }

  const event = payload.event;
  if (!event) {
    return ContentService.createTextOutput("no_event");
  }

  // Bot自身のメッセージは無視
  if (event.subtype === "bot_message") {
    return ContentService.createTextOutput("ignore_bot");
  }

  // メンションされたときだけ処理
  if (event.type === "app_mention") {
    try {
      handleAppMention(event);
    } catch (err) {
      // エラー時は握りつぶす（ユーザーには別途エラーメッセージを送信済み）
    }
  }

  return ContentService.createTextOutput("ok");
}

/**
 * メンションイベント処理
 * - スレッド全文取得 → Geminiで画像生成 → 新APIで画像アップロード
 */
function handleAppMention(event) {
  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;

  // ユーザー向けフィードバック
  postMessageToThread(channel, threadTs, "画像を生成しています... :hourglass_flowing_sand:");

  try {
    const threadText = fetchThreadText(channel, threadTs);
    const imageBlob = generateInfographic(threadText);
    uploadImageToThread(channel, threadTs, imageBlob);
  } catch (err) {
    postMessageToThread(
      channel,
      threadTs,
      "画像の生成中にエラーが発生しました :cry:\nもう一度試してみてください。"
    );
  }
}

/**
 * スレッド全体のテキストを取得
 */
function fetchThreadText(channel, threadTs) {
  const url = "https://slack.com/api/conversations.replies";

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    headers: {
      Authorization: "Bearer " + SLACK_BOT_TOKEN,
    },
    payload: {
      channel: channel,
      ts: threadTs,
      limit: 50,
    },
    muteHttpExceptions: true,
  });

  const text = res.getContentText();
  const data = JSON.parse(text);

  if (!data.ok) {
    throw new Error("Slack API error (conversations.replies): " + text);
  }

  const allText = data.messages
    .map(function (m) {
      return m.text || "";
    })
    .join("\n");

  return allText;
}

/**
 * Gemini でインフォグラフィック画像生成
 */
function generateInfographic(threadText) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent";

  const prompt =
    "次のSlackスレッドの内容を、1枚の分かりやすいインフォグラフィック画像にしてください。日本語を用いてください。" +
    "重要なポイントを要約し、ボックスや矢印などで構造化し、わかりやすいレイアウトにしてください。ユーザー名を指定するときにIDを使わないでください。\n\n" +
    threadText;

  const payload = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  };

  const res = UrlFetchApp.fetch(url, {
    method: "post",
    contentType: "application/json; charset=utf-8",
    headers: {
      "x-goog-api-key": GEMINI_API_KEY,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  const text = res.getContentText();
  const data = JSON.parse(text);

  if (!data.candidates || !data.candidates.length) {
    throw new Error("Gemini response has no candidates");
  }

  const parts =
    (data.candidates[0].content && data.candidates[0].content.parts) || [];
  const imagePart = parts.find(function (p) {
    return p.inlineData;
  });

  if (!imagePart || !imagePart.inlineData || !imagePart.inlineData.data) {
    throw new Error("No inlineData image in Gemini response");
  }

  const base64 = imagePart.inlineData.data;
  const blob = Utilities.newBlob(
    Utilities.base64Decode(base64),
    "image/png",
    "infog.png"
  );

  return blob;
}

/**
 * 新ファイルアップロードAPIで画像をスレッドに貼る
 *
 * 1. files.getUploadURLExternal で upload_url, file_id を取得
 * 2. upload_url に画像バイト列を POST
 * 3. files.completeUploadExternal で channel + thread_ts に紐付けて公開
 */
function uploadImageToThread(channel, threadTs, imageBlob) {
  const filename = "infog.png";
  const bytes = imageBlob.getBytes();
  const length = bytes.length;

  // 1. アップロード用URL取得
  const getUrlRes = UrlFetchApp.fetch(
    "https://slack.com/api/files.getUploadURLExternal",
    {
      method: "post",
      contentType: "application/x-www-form-urlencoded",
      headers: {
        Authorization: "Bearer " + SLACK_BOT_TOKEN,
      },
      payload: {
        filename: filename,
        length: String(length),
      },
      muteHttpExceptions: true,
    }
  );

  const getUrlText = getUrlRes.getContentText();
  const getUrlData = JSON.parse(getUrlText);

  if (!getUrlData.ok) {
    throw new Error("Slack API error (files.getUploadURLExternal): " + getUrlText);
  }

  const uploadUrl = getUrlData.upload_url;
  const fileId = getUrlData.file_id;

  // 2. upload_url にバイナリをPOST
  UrlFetchApp.fetch(uploadUrl, {
    method: "post",
    contentType: "application/octet-stream",
    payload: bytes,
    muteHttpExceptions: true,
  });

  // 3. completeUploadExternal で公開
  const completePayload = {
    channel_id: channel,
    initial_comment: "スレッドを画像にしました :sparkles:",
    thread_ts: threadTs,
    files: [
      {
        id: fileId,
        title: filename,
      },
    ],
  };

  const completeRes = UrlFetchApp.fetch(
    "https://slack.com/api/files.completeUploadExternal",
    {
      method: "post",
      contentType: "application/json; charset=utf-8",
      headers: {
        Authorization: "Bearer " + SLACK_BOT_TOKEN,
      },
      payload: JSON.stringify(completePayload),
      muteHttpExceptions: true,
    }
  );

  const completeText = completeRes.getContentText();
  const completeData = JSON.parse(completeText);

  if (!completeData.ok) {
    throw new Error(
      "Slack API error (files.completeUploadExternal): " + completeText
    );
  }

  return completeText;
}

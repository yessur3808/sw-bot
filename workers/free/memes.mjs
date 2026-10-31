// Images are curated before import. No live scraping or AI-generated image URLs.
export async function memePost(env, updateId) {
  // D1 batches are transactional: concurrent jobs claim different least-used
  // images, and a retry of the same update keeps its original selection.
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO meme_deliveries(update_id,meme_id,created_at)
      SELECT ?,id,? FROM meme_roster WHERE active=1 ORDER BY last_selected,RANDOM() LIMIT 1`)
      .bind(updateId,Math.floor(Date.now()/1000)),
    env.DB.prepare(`UPDATE meme_roster SET last_selected=MAX(last_selected,
      (SELECT sequence FROM meme_deliveries WHERE update_id=?))
      WHERE id=(SELECT meme_id FROM meme_deliveries WHERE update_id=?)`).bind(updateId,updateId)
  ]);
  const row=await env.DB.prepare(`SELECT m.* FROM meme_roster m JOIN meme_deliveries d ON d.meme_id=m.id
    WHERE d.update_id=? AND m.active=1 AND d.message_id IS NULL`).bind(updateId).first();
  if(!row)return null;
  const attribution=`Shared by ${row.author} on Imgflip`;
  const text=`Cantina humour\n\n${attribution}`;
  return {text,photo:row.file_id||row.image_url,meme_id:row.id,seed:`meme:${row.id}`,generation:'meme_image',
    caption_entities:[{type:'text_link',offset:text.indexOf(attribution),length:attribution.length,url:row.source_url}]};
}

export async function memeDeliveryAllowed(env,updateId,body) {
  const row=await env.DB.prepare(`SELECT m.image_url,m.file_id,t.thread_id FROM meme_deliveries d
    JOIN meme_roster m ON m.id=d.meme_id JOIN topic_map t ON t.name='memes'
    WHERE d.update_id=? AND m.active=1 AND d.message_id IS NULL`).bind(updateId).first();
  const paused=await env.DB.prepare("SELECT value FROM settings WHERE key='paused'").first();
  const threads=(env.ALLOWED_THREAD_IDS||'').split(',').filter(Boolean).map(Number);
  return env.PROACTIVE_ENABLED!=='false' && paused?.value!=='1' && (!threads.length||threads.includes(Number(body.message_thread_id||0))) && !!row && Number(body.chat_id)===Number(env.GROUP_ID) && Number(body.message_thread_id||0)===row.thread_id
    && [row.image_url,row.file_id].filter(Boolean).includes(body.photo);
}

export async function memeDelivered(env,updateId,result) {
  const fileId=result.photo?.at(-1)?.file_id||null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE meme_roster SET last_sent_at=?,file_id=COALESCE(?,file_id)
      WHERE id=(SELECT meme_id FROM meme_deliveries WHERE update_id=?)`).bind(Math.floor(Date.now()/1000),fileId,updateId),
    env.DB.prepare('UPDATE meme_deliveries SET message_id=? WHERE update_id=?').bind(result.message_id,updateId)
  ]);
}

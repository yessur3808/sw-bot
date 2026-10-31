// Images are curated before import. No live scraping or AI-generated image URLs.
export async function wallpaperPost(env, updateId) {
  // D1 batches are transactional: concurrent jobs claim different least-used
  // images, and a retry of the same update keeps its original selection.
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO wallpaper_deliveries(update_id,wallpaper_id,created_at)
      SELECT ?,id,? FROM wallpaper_roster WHERE active=1 ORDER BY last_selected,RANDOM() LIMIT 1`)
      .bind(updateId,Math.floor(Date.now()/1000)),
    env.DB.prepare(`UPDATE wallpaper_roster SET last_selected=MAX(last_selected,
      (SELECT sequence FROM wallpaper_deliveries WHERE update_id=?))
      WHERE id=(SELECT wallpaper_id FROM wallpaper_deliveries WHERE update_id=?)`).bind(updateId,updateId)
  ]);
  const row=await env.DB.prepare(`SELECT m.* FROM wallpaper_roster m JOIN wallpaper_deliveries d ON d.wallpaper_id=m.id
    WHERE d.update_id=? AND m.active=1 AND d.message_id IS NULL`).bind(updateId).first();
  if(!row)return null;
  // Internal context only; wallpaper deliveries never include a caption.
  const text="[Star Wars wallpaper image]";
  return {text,photo:row.file_id||row.image_url,wallpaper_id:row.id,seed:`wallpaper:${row.id}`,generation:'wallpaper_image'};
}

export async function wallpaperDeliveryAllowed(env,updateId,body) {
  const row=await env.DB.prepare(`SELECT m.image_url,m.file_id,t.thread_id FROM wallpaper_deliveries d
    JOIN wallpaper_roster m ON m.id=d.wallpaper_id JOIN topic_map t ON t.name='wallpapers'
    WHERE d.update_id=? AND m.active=1 AND d.message_id IS NULL`).bind(updateId).first();
  const paused=await env.DB.prepare("SELECT value FROM settings WHERE key='paused'").first();
  const threads=(env.ALLOWED_THREAD_IDS||'').split(',').filter(Boolean).map(Number);
  return env.PROACTIVE_ENABLED!=='false' && paused?.value!=='1' && (!threads.length||threads.includes(Number(body.message_thread_id||0))) && !!row && Number(body.chat_id)===Number(env.GROUP_ID) && Number(body.message_thread_id||0)===row.thread_id
    && [row.image_url,row.file_id].filter(Boolean).includes(body.photo);
}

export async function wallpaperDelivered(env,updateId,result) {
  const fileId=result.photo?.at(-1)?.file_id||null;
  await env.DB.batch([
    env.DB.prepare(`UPDATE wallpaper_roster SET last_sent_at=?,file_id=COALESCE(?,file_id)
      WHERE id=(SELECT wallpaper_id FROM wallpaper_deliveries WHERE update_id=?)`).bind(Math.floor(Date.now()/1000),fileId,updateId),
    env.DB.prepare('UPDATE wallpaper_deliveries SET message_id=? WHERE update_id=?').bind(result.message_id,updateId)
  ]);
}

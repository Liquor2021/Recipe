const H={'X-App-Token':'nini123'}
const B='http://localhost:8080/api'
;(async()=>{
  const recs = await fetch(B+'/records?pageSize=100',{headers:H}).then(r=>r.json())
  console.log('== 全部记录 ==')
  const items = recs.data?.items || []
  for(const r of items) console.log(r.meal_date, r.dish_name, 'rating='+r.rating, r.meal_type)
  const today = new Date().toISOString().slice(0,10)
  console.log('today =', today)
  const week = items.filter(r => r.meal_date >= '2026-10-26' && r.meal_date <= today)
  const rated = week.filter(r => r.rating > 0)
  console.log('本周记录数:', week.length, '有评分:', rated.length, '均分:', rated.length ? (rated.reduce((s,r)=>s+r.rating,0)/rated.length).toFixed(2) : '-')
  const rep = await fetch(B+'/report?range=week',{headers:H}).then(r=>r.json())
  console.log('报告: cook_days='+rep.data.cook_days, 'total='+rep.data.total_meals, 'avg='+rep.data.avg_rating, 'repeat='+rep.data.repeat_rate+'%', 'new='+rep.data.new_dish_rate+'%')
  console.log('报告 top:', rep.data.top_dishes.map(d=>d.dish_name+'x'+d.count).join(', '))
})()

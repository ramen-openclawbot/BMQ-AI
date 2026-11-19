-- Trình chi gấp: tắt nhắc lại trên Zalo (tối đa 8 lần, mỗi 6 tiếng).
-- Owner 19/11/2026: "Bỏ nhắc thanh toán gấp qua zalo 8 lần".
-- Chỉ tạm dừng job cron; tin "Trình chi gấp" lúc tạo đợt chi vẫn gửi như cũ.
-- Bật lại: select cron.alter_job(jobid, active := true) from cron.job where jobname = 'payment-submission-reminders-hourly';
select cron.alter_job(j.jobid, active := false)
  from cron.job j
 where j.jobname = 'payment-submission-reminders-hourly';

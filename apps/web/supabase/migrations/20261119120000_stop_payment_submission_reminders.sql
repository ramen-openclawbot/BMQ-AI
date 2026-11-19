-- Trình chi gấp: tắt nhắc lại trên Zalo (tối đa 8 lần, mỗi 6 tiếng).
-- Owner 19/11/2026: "Bỏ nhắc thanh toán gấp qua zalo 8 lần".
-- Chỉ tạm dừng job cron; tin "Trình chi gấp" lúc tạo đợt chi vẫn gửi như cũ.
-- Bật lại: update cron.job set active = true where jobname = 'payment-submission-reminders-hourly';
update cron.job
   set active = false
 where jobname = 'payment-submission-reminders-hourly';

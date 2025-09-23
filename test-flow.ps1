# test-flow.ps1
# Full end-to-end test flow for EasyQue backend
# Usage: edit $base, $loginEmail, $loginPassword if needed, then run in PowerShell

$ErrorActionPreference = 'Stop'

# ------------- CONFIG -------------
$base = 'http://localhost:8080'     # change if your server uses different host/port
$loginEmail = 'easyque0@gmail.com'  # existing admin user email
$loginPassword = 'Mylefin@141'      # admin password
# -----------------------------------

Write-Host "==> Starting EasyQue test flow against $base"

# 1) Login
Write-Host "`n==> 1) Login"
$loginBody = @{
  email = $loginEmail
  password = $loginPassword
} | ConvertTo-Json

$loginResp = Invoke-RestMethod -Uri "$base/auth/login" -Method POST -ContentType 'application/json' -Body $loginBody
Write-Host "Login response:"
$loginResp | ConvertTo-Json -Depth 5

$accessToken = $loginResp.accessToken
if (-not $accessToken) { throw "No accessToken returned from /auth/login" }

$headers = @{ Authorization = "Bearer $accessToken" }

# Create unique suffix so repeated runs don't conflict
$ts = (Get-Date -Format 'yyyyMMddHHmmss')

# 2) Create two assigned users: fromUser (initial assigned user) and toUser (target)
Write-Host "`n==> 2) Create two assigned users (fromUser, toUser)"

function CreateUser([string]$name, [string]$email, [string]$password, [string]$role, [int]$orgId) {
  $body = @{
    name = $name
    email = $email
    password = $password
    role = $role
    org_id = $orgId
  } | ConvertTo-Json

  $resp = Invoke-RestMethod -Uri "$base/users" -Method POST -Headers $headers -ContentType 'application/json' -Body $body
  return $resp
}

# Ensure org_id set to 1 (change if you use different orgs)
$orgId = 1

# fromUser
$fromName = "AssignedFrom-$ts"
$fromEmail = "assigned_from_$ts@example.com"
$fromPass  = "Passw0rd!$ts"

Write-Host "Creating fromUser $fromEmail ..."
$fromResp = CreateUser -name $fromName -email $fromEmail -password $fromPass -role 'assigned' -orgId $orgId
$fromUserId = $fromResp.user.id
Write-Host "fromUser id: $fromUserId"

# toUser
$toName = "AssignedTo-$ts"
$toEmail = "assigned_to_$ts@example.com"
$toPass  = "Passw0rd!$ts"

Write-Host "Creating toUser $toEmail ..."
$toResp = CreateUser -name $toName -email $toEmail -password $toPass -role 'assigned' -orgId $orgId
$toUserId = $toResp.user.id
Write-Host "toUser id: $toUserId"

# 3) Create booking assigned to fromUser
Write-Host "`n==> 3) Create booking (assigned to fromUser $fromUserId)"

$bookingDate = (Get-Date).ToString('yyyy-MM-dd')
$createBody = @{
  org_id = $orgId
  user_name = "PS Test User $ts"
  user_phone = "9999999999"
  assigned_user_id = $fromUserId
  booking_date = $bookingDate
  booking_time = "10:00:00"
  prefer_video = 0
  notes = "Created via PowerShell test $ts"
} | ConvertTo-Json

try {
  $createResp = Invoke-RestMethod -Uri "$base/bookings" -Method POST -Headers $headers -ContentType 'application/json' -Body $createBody
  Write-Host "Create booking response:"
  $createResp | ConvertTo-Json -Depth 5
} catch {
  Write-Error "ERROR creating booking: $_"
  throw
}

$bookingId = $createResp.booking.id
if (-not $bookingId) { throw "bookingId missing in create response" }
Write-Host "Created booking id: $bookingId"

# 4) Mark as served
Write-Host "`n==> 4) Mark booking as served"
try {
  $serveResp = Invoke-RestMethod -Uri "$base/bookings/$bookingId/serve" -Method PUT -Headers $headers -ContentType 'application/json'
  Write-Host "Serve response:"
  $serveResp | ConvertTo-Json -Depth 5
} catch {
  Write-Error "ERROR calling serve endpoint: $_"
  throw
}

# 5) Reassign booking to toUser
Write-Host "`n==> 5) Reassign booking to user $toUserId"
$reassignBody = @{
  new_assigned_user_id = $toUserId
  reason = "Load balancing - test"
} | ConvertTo-Json

try {
  $reassignResp = Invoke-RestMethod -Uri "$base/bookings/$bookingId/reassign" -Method PUT -Headers $headers -ContentType 'application/json' -Body $reassignBody
  Write-Host "Reassign response:"
  $reassignResp | ConvertTo-Json -Depth 5
} catch {
  Write-Error "ERROR calling reassign endpoint: $_"
  throw
}

# 6) Cancel booking
Write-Host "`n==> 6) Cancel booking"
try {
  $cancelResp = Invoke-RestMethod -Uri "$base/bookings/$bookingId/cancel" -Method PUT -Headers $headers -ContentType 'application/json'
  Write-Host "Cancel response:"
  $cancelResp | ConvertTo-Json -Depth 5
} catch {
  Write-Error "ERROR calling cancel endpoint: $_"
  throw
}

Write-Host "`n==> Done. All steps completed successfully."

# Ski Swap
## Previous Individual Seller Import Process

```plantuml
@startuml
start

:administrator initiates import via WebUI;
:administrator submits CSV listing all previous sellers;

while (have more sellers?)

    :get next seller from csv;
    if (does user email exist?) is (yes) then
    else (no)
        if (does user phone exist?) is (yes) then
        else (no)
            :create user from CSV\n(do NOT validate contact info);
        endif
    endif

endwhile

:add individual seller membership user to org;

stop
@enduml
```



## Staff Adds Individual Seller
```plantuml
@startuml
start

:staff clicks "Add Individual Seller" on WebUI;
:staff searches by users's email or phone number\n(all users);
if (does user email or phone exist?) is (yes) then
    :show matching name to staff;
    if (staff asks for confirmation from seller) is (confirmed) then
        :add individual seller membership user to org;
        :return user information to staff for editing;
    else (not confirmed)
        :already have account with this name;
        stop
    endif
else (no)
    :staff enters all user information;
    :staff clicks save;
    :user created from info\n
    (do NOT validate contact info);
    :add individual seller membership user to org;
endif


stop
@enduml
```



## Staff Adds Business Seller
```plantuml
@startuml
start

:staff clicks "Add Business Seller" on WebUI;
:staff searches for business name\n(all businesses)
:show matching name to staff(\nautocomplete);
if (staff sees desired busines?) is (yes) then
    :add business seller membership user to org;
    :notify business via email that they've been added to org;
else (no)
    :staff enters business name + email address;
    :create user with name + email address;
    :add business seller membership user to org;
    :notify business via email that they've been added to org;
    stop
endif


stop
@enduml
```


## Self-service Check-in
```plantuml
@startuml
title Self-service Check-in

start

:scan QR code with phone @ venue\n(contains orgId);
:user enters email or phone number for magic link;
if (does user exist\n(by email or phone)?) is (yes) then
else (no)
    :user sign-up form\n(name, address, email, phone);
    :create user;
endif
:user is sent magic link by email or phone;
:user logs in via magic link
:mark this contact method verified\n(email or phone)
:add individual seller membership user to org;

stop
@enduml
```


# Patroller / Roster
## Patroller Import Process
```plantuml
@startuml
start

:administrator initiates import via WebUI;
:administrator submits CSV listing all patrollers;

while (have more patrollers?)

    :get next patroller from csv;
    if (does user email exist?) is (yes) then
    else (no)
        if (does user phone exist?) is (yes) then
        else (no)
            :create user from CSV\n(do NOT validate contact info);
        endif
    endif

endwhile

:add patroller membership user to org;

if (user previously existed\n(not newly created)) is (yes) then
:notify patroller via email that they've been added to org;
endif

stop
@enduml
```
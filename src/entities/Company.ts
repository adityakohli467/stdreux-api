import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  Index,
} from "typeorm"
import { Customer } from "./Customer"
import { Department } from "./Department"

@Entity("company")
@Index(["company_status"])
export class Company {
  @PrimaryGeneratedColumn()
  company_id!: number

  @Column({ type: "varchar", length: 255 })
  company_name!: string

  @Column({ type: "varchar", length: 50, nullable: true })
  company_abn!: string

  @Column({ type: "varchar", length: 50 })
  company_phone!: string

  @Column({ type: "text", nullable: true })
  company_address!: string

  @Column({ type: "int", default: 1 })
  company_status!: number

  @Column({ type: "boolean", default: false })
  pay_later!: boolean

  @CreateDateColumn({ name: "company_created_on" })
  company_created_on!: Date

  // Relations
  @OneToMany(() => Customer, (customer) => customer.company)
  customers!: Customer[]

  @OneToMany(() => Department, (department) => department.company)
  departments!: Department[]
}

